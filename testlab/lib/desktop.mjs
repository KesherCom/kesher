// Desktop-app audio benchmark (make lab-desktop): runs the native audio
// engine of the Tauri app (desktop/src-tauri, via the kesher_audio_bench
// tool) against lab servers with emulated networks and reports latency and
// audio quality, compared with a saved baseline.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LAB_DIR, ROOT_DIR, PROFILES, profileURL, listFromEnv } from "./lab.mjs";
import { buildServer, startNative, stopNative, LOG_DIR } from "./instances.mjs";

const isWin = process.platform === "win32";
const TAURI_DIR = path.join(ROOT_DIR, "desktop", "src-tauri");
const BENCH_BIN = path.join(TAURI_DIR, "target", "release", isWin ? "kesher_audio_bench.exe" : "kesher_audio_bench");
const RESULTS = path.join(LAB_DIR, "results");
const BASELINE = path.join(RESULTS, "desktop-baseline.json");
// Speech-quality pass: the talker plays this clip, pesq_score.py rates what
// the listener heard (wideband PESQ, MOS 1.0 .. 4.64).
const SPEECH_WAV = path.join(LAB_DIR, "assets", "speech.wav");
const PESQ_SCRIPT = path.join(LAB_DIR, "lib", "pesq_score.py");
const PYTHON = process.env.LAB_PYTHON || (isWin ? "python" : "python3");

let speechCheck = null;
/** Speech scoring needs the clip plus Python with numpy, scipy and pesq. */
function speechAvailable() {
  if (speechCheck) return speechCheck;
  if (process.env.LAB_SPEECH === "0") return (speechCheck = { ok: false, why: "disabled (LAB_SPEECH=0)" });
  if (!existsSync(SPEECH_WAV)) return (speechCheck = { ok: false, why: `missing ${path.relative(ROOT_DIR, SPEECH_WAV)}` });
  const res = spawnSync(PYTHON, ["-c", "import numpy, scipy, pesq"], { encoding: "utf8" });
  if (res.status !== 0) return (speechCheck = { ok: false, why: `${PYTHON} needs numpy, scipy and pesq (pip install pesq)` });
  return (speechCheck = { ok: true });
}

function buildBench() {
  console.log("lab: building desktop audio bench (desktop/src-tauri, release)...");
  const res = spawnSync("cargo", ["build", "--release", "--features", "bench", "--bin", "kesher_audio_bench"], {
    cwd: TAURI_DIR,
    stdio: "inherit",
    shell: isWin,
  });
  if (res.status !== 0) throw new Error("cargo build of kesher_audio_bench failed");
}

async function health(url) {
  try {
    return (await fetch(`${url}/api/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function waitHealthy(profiles, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if ((await Promise.all(profiles.map((p) => health(profileURL(p))))).every(Boolean)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * A logged-in native (desktop) session: REST login + WebSocket with
 * transport=native, room matrix and voice state like the app sends them.
 * Resolves with the relay endpoint the engine needs.
 */
async function nativeSession(baseURL, { username, role, listen, talk, ptt }) {
  const res = await fetch(`${baseURL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, roleId: role }),
  });
  if (!res.ok) throw new Error(`login ${username}: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  const ws = new WebSocket(`${baseURL.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}&transport=native`);
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${username}: no native_audio_endpoint (is UDP_AUDIO_ADDR set?)`)), 10_000);
    ws.addEventListener("error", () => reject(new Error(`${username}: websocket error`)));
    ws.addEventListener("open", () => {
      const send = (type, data) => ws.send(JSON.stringify({ type, data }));
      send("set_room_matrix", { listenRoomIds: listen, talkRoomIds: talk });
      send("voice_state", { scope: "room", targetId: talk[0] || listen[0], body: ptt ? "ptt_start" : "ptt_stop" });
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "native_audio_endpoint") {
          clearTimeout(timer);
          resolve(msg.data);
        }
      } catch {
        /* other messages */
      }
    });
  });
  return { ws, endpoint, close: () => ws.close() };
}

function runBench(mode, config) {
  mkdirSync(path.join(LAB_DIR, ".cache"), { recursive: true });
  const file = path.join(LAB_DIR, ".cache", `bench-${mode}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2));
  const res = spawnSync(BENCH_BIN, [mode, file], {
    encoding: "utf8",
    env: { RUST_LOG: "warn", ...process.env },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.stderr?.trim()) {
    const tail = res.stderr.trim().split(/\r?\n/).slice(-5).join("\n    ");
    if (res.status !== 0 || process.env.LAB_VERBOSE) console.log(`    ${tail}`);
  }
  const line = (res.stdout || "").trim().split(/\r?\n/).pop() || "{}";
  try {
    return JSON.parse(line);
  } catch {
    return { error: `bench produced no result (exit ${res.status})` };
  }
}

let userSeq = 0;
async function virtualScenario(profile, frameMs, opts) {
  const baseURL = profileURL(profile);
  const id = `${Date.now() % 100000}${userSeq++}`;
  const talker = await nativeSession(baseURL, { username: `benchtalk${id}`, role: "audio", listen: [], talk: ["foh"], ptt: true });
  const listener = await nativeSession(baseURL, { username: `benchhear${id}`, role: "producer", listen: ["foh"], talk: [], ptt: false });
  try {
    return runBench("virtual", {
      talker: talker.endpoint,
      listener: listener.endpoint,
      durationSeconds: opts.seconds,
      periodFrames: opts.periodFrames,
      frameMs,
    });
  } finally {
    talker.close();
    listener.close();
  }
}

/** Plays the speech clip through the chain and scores it with PESQ. */
async function speechScenario(profile, frameMs, opts, runId) {
  const baseURL = profileURL(profile);
  const id = `${Date.now() % 100000}${userSeq++}`;
  const recordDir = path.join(RESULTS, "speech", `${runId}-${profile}-${frameMs}ms`);
  const talker = await nativeSession(baseURL, { username: `benchspk${id}`, role: "audio", listen: [], talk: ["foh"], ptt: true });
  const listener = await nativeSession(baseURL, { username: `benchlst${id}`, role: "producer", listen: ["foh"], talk: [], ptt: false });
  let bench;
  try {
    bench = runBench("virtual", {
      talker: talker.endpoint,
      listener: listener.endpoint,
      durationSeconds: opts.speechSeconds,
      periodFrames: opts.periodFrames,
      frameMs,
      speechWav: SPEECH_WAV,
      recordDir,
    });
  } finally {
    talker.close();
    listener.close();
  }
  if (bench.error) return bench;
  const res = spawnSync(PYTHON, [PESQ_SCRIPT, bench.referenceWav, bench.degradedWav], { encoding: "utf8" });
  const line = (res.stdout || "").trim().split(/\r?\n/).pop() || "{}";
  try {
    return { ...JSON.parse(line), recordDir: path.relative(ROOT_DIR, recordDir) };
  } catch {
    return { error: `pesq_score failed: ${(res.stderr || "").trim().split(/\r?\n/).pop()}` };
  }
}

/** Relay counters from /api/realtime-stats (lab servers do not gate admin). */
async function relayStats(baseURL, token) {
  try {
    const res = await fetch(`${baseURL}/api/realtime-stats`, {
      headers: { Authorization: `Bearer ${token}`, "X-Admin-Pin": process.env.ADMIN_PIN || "123456" },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? (await res.json()).udpAudio || null : null;
  } catch {
    return null;
  }
}

/**
 * N desktop clients on one party line, all talking and listening at once:
 * per-pair latency, clipping in the mix and callback time under load, plus
 * the relay's own stall counters.
 */
async function multiScenario(profile, talkers, frameMs, opts) {
  const baseURL = profileURL(profile);
  const id = `${Date.now() % 100000}${userSeq++}`;
  const sessions = [];
  try {
    for (let i = 0; i < talkers; i++) {
      sessions.push(
        await nativeSession(baseURL, { username: `benchmulti${id}x${i}`, role: "audio", listen: ["foh"], talk: ["foh"], ptt: true }),
      );
    }
    const token = sessions[0].endpoint.token;
    const before = await relayStats(baseURL, token);
    const r = runBench("multi", {
      endpoints: sessions.map((s) => s.endpoint),
      durationSeconds: opts.multiSeconds,
      speechSeconds: opts.multiSeconds,
      periodFrames: opts.periodFrames,
      frameMs,
      speechWav: existsSync(SPEECH_WAV) ? SPEECH_WAV : null,
    });
    const after = await relayStats(baseURL, token);
    if (before && after) {
      r.relay = {
        rxFrames: after.rxFrames - before.rxFrames,
        txFrames: after.txFrames - before.txFrames,
        txErrors: (after.txErrors || 0) - (before.txErrors || 0),
        inboundGapsOver20ms: after.inboundGapsOver20ms - before.inboundGapsOver20ms,
        maxInboundGapMs: after.maxInboundGapMs,
        maxRouteMs: after.maxRouteMs,
      };
    }
    return r;
  } finally {
    for (const s of sessions) s.close();
  }
}

async function hardwareScenario(profile, frameMs, opts) {
  const baseURL = profileURL(profile);
  const id = `${Date.now() % 100000}${userSeq++}`;
  const self = await nativeSession(baseURL, { username: `benchhw${id}`, role: "audio", listen: ["foh"], talk: ["foh"], ptt: false });
  try {
    return runBench("hardware", {
      endpoint: self.endpoint,
      runs: opts.runs,
      frameMs,
      inputDevice: process.env.LAB_HW_INPUT || null,
      outputDevice: process.env.LAB_HW_OUTPUT || null,
      audioBackend: process.env.LAB_HW_BACKEND || null,
    });
  } finally {
    self.close();
  }
}

const fmt = (v, w, unit = "") => String(v === undefined || v === null || Number.isNaN(v) ? "–" : `${v}${unit}`).padEnd(w);

function delta(now, base, w) {
  if (now == null || base == null) return "".padEnd(w);
  const d = Math.round((now - base) * 10) / 10;
  return (d === 0 ? "±0" : d > 0 ? `+${d}` : `${d}`).padEnd(w);
}

function printTable(rows, baseline) {
  const base = new Map((baseline?.rows || []).map((r) => [r.key, r]));
  console.log("");
  console.log("Desktop app audio: talker → server → listener (native engine, virtual devices)");
  const head = [
    ["scenario", 18],
    ["p50", 8],
    ["p95", 8],
    ["max", 8],
    ["Δp50", 7],
    ["Δp95", 7],
    ["jbuf", 7],
    ["distort", 8],
    ["Δdist", 7],
    ["SNR", 6],
    ["dropout", 8],
    ["PLC/min", 8],
    ["fec", 5],
    ["late", 5],
    ["heard", 7],
    ["MOS", 5],
    ["MOSmin", 6],
    ["ΔMOS", 6],
  ];
  console.log(head.map(([n, w]) => n.padEnd(w)).join(" "));
  console.log(head.map(([, w]) => "-".repeat(w)).join(" "));
  for (const r of rows.filter((x) => x.mode === "virtual")) {
    const b = base.get(r.key);
    if (r.error) {
      console.log(`${r.key.padEnd(18)} ERROR: ${r.error}`);
      continue;
    }
    const L = r.latencyMs || {};
    console.log(
      [
        fmt(r.key, 18),
        fmt(L.p50, 8, "ms"),
        fmt(L.p95, 8, "ms"),
        fmt(L.max, 8, "ms"),
        delta(L.p50, b?.latencyMs?.p50, 7),
        delta(L.p95, b?.latencyMs?.p95, 7),
        fmt(r.jitterBufferTargetMs?.mean, 7, "ms"),
        fmt(r.distortedPct, 8, "%"),
        delta(r.distortedPct, b?.distortedPct, 7),
        fmt(r.toneSnrDb?.p50 != null ? Math.round(r.toneSnrDb.p50) : null, 6, "dB"),
        fmt(r.dropoutPct, 8, "%"),
        fmt(r.concealedPerMin, 8),
        fmt(r.listener?.fecRecovered, 5),
        fmt(r.listener?.latePackets, 5),
        fmt(`${r.markersHeard}/${r.markersSent}`, 7),
        fmt(r.speech?.mos, 5),
        fmt(r.speech?.mosMin, 6),
        delta(r.speech?.mos, b?.speech?.mos, 6),
      ].join(" "),
    );
  }
  const multi = rows.filter((x) => x.mode === "multi");
  if (multi.length) {
    console.log("");
    console.log("Party line: N desktop clients talking and listening at once (virtual devices, shared clock)");
    const mhead = [
      ["scenario", 18],
      ["p50", 8],
      ["p95", 8],
      ["worst pair", 11],
      ["Δp95", 7],
      ["heard", 11],
      ["clip", 7],
      ["Δclip", 6],
      ["cb avg", 8],
      ["cb max", 8],
      ["PLC", 5],
      ["late", 5],
      ["rx gaps", 8],
      ["relay gaps", 11],
      ["relay max", 9],
    ];
    console.log(mhead.map(([n, w]) => n.padEnd(w)).join(" "));
    console.log(mhead.map(([, w]) => "-".repeat(w)).join(" "));
    for (const r of multi) {
      const b = base.get(r.key);
      if (r.error) {
        console.log(`${r.key.padEnd(18)} ERROR: ${r.error}`);
        continue;
      }
      const L = r.latencyMs || {};
      console.log(
        [
          fmt(r.key, 18),
          fmt(L.p50, 8, "ms"),
          fmt(L.p95, 8, "ms"),
          fmt(r.worstPairP95Ms, 11, "ms"),
          delta(L.p95, b?.latencyMs?.p95, 7),
          fmt(`${r.markersHeard}/${r.markersExpected}`, 11),
          fmt(r.clippedPct, 7, "%"),
          delta(r.clippedPct, b?.clippedPct, 6),
          fmt(r.renderAvgUs != null ? Math.round(r.renderAvgUs) : null, 8, "µs"),
          fmt(r.renderMaxMs != null ? Math.round(r.renderMaxMs * 100) / 100 : null, 8, "ms"),
          fmt(r.concealed, 5),
          fmt(r.latePackets, 5),
          fmt(r.rxGapsOver20ms, 8),
          fmt(r.relay?.inboundGapsOver20ms, 11),
          fmt(r.relay?.maxRouteMs != null ? Math.round(r.relay.maxRouteMs * 10) / 10 : null, 9, "ms"),
        ].join(" "),
      );
    }
  }

  const hw = rows.filter((x) => x.mode === "hardware");
  if (hw.length) {
    console.log("");
    console.log("Desktop app, real devices: mouth-to-ear via relay echo (click → output → input)");
    for (const r of hw) {
      if (r.error) {
        console.log(`${r.key.padEnd(18)} ERROR: ${r.error}`);
        continue;
      }
      const L = r.latencyMs || {};
      const b = base.get(r.key);
      console.log(
        `${fmt(r.key, 18)} p50 ${fmt(L.p50, 9, "ms")} p95 ${fmt(L.p95, 9, "ms")} Δp50 ${delta(L.p50, b?.latencyMs?.p50, 7)}` +
          `detected ${L.count}/${r.runs}  in: ${r.input?.backend} ${r.input?.periodMs ?? "?"}ms  out: ${r.output?.backend} ${r.output?.periodMs ?? "?"}ms`,
      );
    }
  }
  console.log("");
  console.log("p50/p95/max  one-way latency talker → listener incl. framing, Opus, network, relay, jitter buffer,");
  console.log("             decode and one device period each side. Real sound cards add their own buffers on top");
  console.log("             (measure with LAB_DESKTOP_HARDWARE=1 and a cable from output to input).");
  console.log("distort      share of 5 ms windows where the received test tone is audibly damaged (SNR < 20 dB:");
  console.log("             PLC artifacts, clicks, gaps). SNR = median tone SNR. dropout = windows that were silent.");
  console.log("PLC/min      packet-loss concealment events; fec = packets rebuilt from Opus FEC; late = arrived too late.");
  console.log("MOS         speech quality of a voice clip sent through the same path: wideband PESQ (ITU-T P.862.2),");
  console.log("             1.0 bad .. 4.64 perfect; mean and worst 8 s segment. Recordings in testlab/results/speech/.");
  console.log("Δ            difference to the baseline (save one with: make lab-desktop-baseline).");
  if (multi.length) {
    console.log("party line   worst pair = highest p95 of any talker → listener pair; heard = markers attributed /");
    console.log("             expected; clip = mixed samples over full scale while everyone speaks at once;");
    console.log("             cb = output-callback time (decode + jitter buffers + mix) per period; rx gaps = engine");
    console.log("             receive gaps > 20 ms; relay gaps / max = server inbound gaps > 20 ms / slowest fan-out.");
  }
}

function compareRegressions(rows, baseline) {
  if (!baseline) return [];
  const base = new Map(baseline.rows.map((r) => [r.key, r]));
  const tolMs = Number(process.env.LAB_DESKTOP_TOLERANCE_MS || 3);
  const tolDist = Number(process.env.LAB_DESKTOP_TOLERANCE_DISTORTION || 1);
  const tolMos = Number(process.env.LAB_DESKTOP_TOLERANCE_MOS || 0.2);
  const out = [];
  for (const r of rows) {
    const b = base.get(r.key);
    if (b && !r.error && r.mode === "multi") {
      if (r.latencyMs?.p95 - b.latencyMs?.p95 > tolMs) out.push(`${r.key}: p95 ${b.latencyMs.p95} → ${r.latencyMs.p95} ms`);
      continue;
    }
    if (!b || r.error || r.mode !== "virtual") continue;
    if (r.latencyMs?.p95 - b.latencyMs?.p95 > tolMs) out.push(`${r.key}: p95 ${b.latencyMs.p95} → ${r.latencyMs.p95} ms`);
    if (r.distortedPct - b.distortedPct > tolDist) out.push(`${r.key}: distortion ${b.distortedPct} → ${r.distortedPct} %`);
    if (b.speech?.mos != null && r.speech?.mos != null && b.speech.mos - r.speech.mos > tolMos) {
      out.push(`${r.key}: speech MOS ${b.speech.mos} → ${r.speech.mos}`);
    }
  }
  return out;
}

/** make lab-desktop: build, start servers if needed, measure, report. */
export async function runDesktop(flags) {
  const profiles = String(flags.profiles || process.env.LAB_PROFILES || "lan,wifi,wan,worst").split(",").filter(Boolean);
  const frames = listFromEnv("LAB_FRAME_MS", String(flags.frames || "5").split(",")).map(Number);
  const opts = {
    seconds: Number(flags.seconds || process.env.LAB_DESKTOP_SECONDS || 20),
    periodFrames: Number(flags.period || process.env.LAB_DESKTOP_PERIOD || 128),
    runs: Number(flags.runs || process.env.LAB_HW_RUNS || 10),
    speechSeconds: Number(flags["speech-seconds"] || process.env.LAB_SPEECH_SECONDS || 24),
    multiSeconds: Number(process.env.LAB_MULTI_SECONDS || 15),
  };
  // Party-line runs: talker counts, on these profiles (LAB_MULTI=0 skips).
  const multiCounts = String(flags.multi ?? process.env.LAB_MULTI ?? "4,8")
    .split(",")
    .map(Number)
    .filter((x) => x >= 2);
  const multiProfiles = String(process.env.LAB_MULTI_PROFILES || "lan").split(",").filter(Boolean);
  const speech = speechAvailable();
  if (!speech.ok) console.log(`lab: speech-quality pass skipped: ${speech.why}`);
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const hardware = Boolean(flags.hardware || process.env.LAB_DESKTOP_HARDWARE);
  for (const p of profiles) if (!PROFILES[p]) throw new Error(`unknown profile ${p}`);

  if (!flags["no-build"]) buildBench();
  else if (!existsSync(BENCH_BIN)) throw new Error(`${BENCH_BIN} missing — run without --no-build`);

  // Reuse running lab servers (make lab-up), otherwise start our own.
  let children = null;
  if (!(await waitHealthy(profiles, 1))) {
    if (!flags["no-build"]) buildServer({ withUI: false });
    console.log(`lab: starting servers (${profiles.join(", ")}), logs in ${path.relative(ROOT_DIR, LOG_DIR)}`);
    children = startNative(profiles, { publicIP: "127.0.0.1" });
    if (!(await waitHealthy(profiles, 20))) {
      stopNative(children);
      throw new Error("lab servers did not become healthy — see testlab/results/logs");
    }
  } else {
    console.log("lab: using already running lab servers");
  }

  const rows = [];
  try {
    for (const profile of profiles) {
      for (const frameMs of frames) {
        const key = `${profile} ${frameMs}ms`;
        process.stdout.write(`lab: measuring ${key} (${opts.seconds}s)... `);
        let r;
        try {
          r = await virtualScenario(profile, frameMs, opts);
        } catch (err) {
          r = { error: String(err.message || err) };
        }
        const row = { key, profile, frameMs, mode: "virtual", ...r };
        rows.push(row);
        console.log(r.error ? `error: ${r.error}` : `p50 ${r.latencyMs?.p50} ms, distortion ${r.distortedPct} %`);
        if (speech.ok) {
          process.stdout.write(`lab: speech quality ${key} (${opts.speechSeconds}s)... `);
          try {
            row.speech = await speechScenario(profile, frameMs, opts, runId);
          } catch (err) {
            row.speech = { error: String(err.message || err) };
          }
          console.log(row.speech.error ? `error: ${row.speech.error}` : `MOS ${row.speech.mos} (worst segment ${row.speech.mosMin})`);
        }
        if (hardware) {
          const hkey = `${profile} ${frameMs}ms hw`;
          process.stdout.write(`lab: hardware loopback ${hkey} (${opts.runs} clicks)... `);
          let h;
          try {
            h = await hardwareScenario(profile, frameMs, opts);
          } catch (err) {
            h = { error: String(err.message || err) };
          }
          rows.push({ key: hkey, profile, frameMs, ...h, mode: "hardware" });
          console.log(h.error ? `error: ${h.error}` : `p50 ${h.latencyMs?.p50} ms (${h.latencyMs?.count}/${h.runs} detected)`);
        }
      }
    }
    for (const profile of profiles.filter((p) => multiProfiles.includes(p))) {
      for (const talkers of multiCounts) {
        const key = `${profile} ${talkers} talkers`;
        process.stdout.write(`lab: party line ${key} (${opts.multiSeconds}s latency + ${opts.multiSeconds}s speech)... `);
        let r;
        try {
          r = await multiScenario(profile, talkers, frames[0], opts);
        } catch (err) {
          r = { error: String(err.message || err) };
        }
        rows.push({ key, profile, frameMs: frames[0], ...r, mode: "multi" });
        console.log(r.error ? `error: ${r.error}` : `p95 ${r.latencyMs?.p95} ms, clipping ${r.clippedPct} %`);
      }
    }
  } finally {
    if (children) stopNative(children);
  }

  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
  printTable(rows, baseline);

  mkdirSync(RESULTS, { recursive: true });
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT_DIR, encoding: "utf8" }).stdout?.trim();
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "desktop", "backend"], { cwd: ROOT_DIR, encoding: "utf8" }).stdout?.trim();
  const report = { createdAt: new Date().toISOString(), git: git ? `${git}${dirty ? "-dirty" : ""}` : null, opts, rows };
  const file = path.join(RESULTS, `desktop-${report.createdAt.replace(/[:.]/g, "-").slice(0, 19)}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`Saved: ${path.relative(ROOT_DIR, file)}`);
  if (flags["save-baseline"]) {
    writeFileSync(BASELINE, JSON.stringify(report, null, 2));
    console.log(`Baseline updated: ${path.relative(ROOT_DIR, BASELINE)}`);
  } else if (baseline) {
    console.log(`Compared with baseline from ${baseline.createdAt} (${baseline.git || "?"})`);
  }

  const failures = rows.filter((r) => r.error || (r.mode === "virtual" && !(r.markersHeard > 0)));
  const regressions = compareRegressions(rows, baseline);
  if (regressions.length) {
    console.log("\nRegressions vs baseline:");
    for (const r of regressions) console.log(`  ${r}`);
  }
  return failures.length === 0 && (regressions.length === 0 || !flags.strict);
}
