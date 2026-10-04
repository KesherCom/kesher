// Shared helpers for the kesher test lab (Playwright tests + lab.mjs CLI).
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LAB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT_DIR = path.join(LAB_DIR, "..");

// Network values are per client link and direction (talker → server and
// server → listener each get them). Keep in sync with
// deploy/compose/docker-compose.lab.yml. Override per run with
// LAB_<PROFILE>_<KEY>, e.g. LAB_WAN_LATENCY_MS=120.
const NONE = { LATENCY_MS: 0, JITTER_MS: 0, LOSS_PCT: 0, REORDER_PCT: 0, DUPLICATE_PCT: 0 };
export const PROFILES = {
  lan: { port: 8180, webrtcPort: 18180, nativePort: 18280, desc: "ideal LAN (no emulation)", netem: NONE },
  wifi: {
    port: 8181,
    webrtcPort: 18181,
    nativePort: 18281,
    desc: "Wi-Fi: 15 ms ±6 ms, 0.5 % loss",
    netem: { ...NONE, LATENCY_MS: 15, JITTER_MS: 6, LOSS_PCT: 0.5 },
  },
  wan: {
    port: 8182,
    webrtcPort: 18182,
    nativePort: 18282,
    desc: "WAN/VPN: 60 ms ±15 ms, 1 % loss, 0.5 % reorder",
    netem: { ...NONE, LATENCY_MS: 60, JITTER_MS: 15, LOSS_PCT: 1, REORDER_PCT: 0.5 },
  },
  worst: {
    port: 8183,
    webrtcPort: 18183,
    nativePort: 18283,
    desc: "bad link: 150 ms ±40 ms, 5 % loss, 2 % reorder",
    netem: { LATENCY_MS: 150, JITTER_MS: 40, LOSS_PCT: 5, REORDER_PCT: 2, DUPLICATE_PCT: 0.5 },
  },
};

/** Base URL of a lab instance. LAB_URL_<PROFILE> overrides (e.g. a real server). */
export function profileURL(profile) {
  const override = process.env[`LAB_URL_${profile.toUpperCase()}`];
  if (override) return override.replace(/\/$/, "");
  const p = PROFILES[profile];
  if (!p) throw new Error(`unknown lab profile "${profile}" (known: ${Object.keys(PROFILES).join(", ")})`);
  return `http://127.0.0.1:${p.port}`;
}

export function listFromEnv(key, fallback) {
  const raw = (process.env[key] || "").trim();
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
}

/**
 * Browser names understood by the lab. "chrome" / "msedge" use the locally
 * installed browsers (Playwright channels), the rest Playwright's own builds.
 */
export const BROWSERS = {
  chromium: { type: "chromium" },
  chrome: { type: "chromium", channel: "chrome" },
  msedge: { type: "chromium", channel: "msedge" },
  firefox: { type: "firefox" },
  webkit: { type: "webkit" },
};

/** Best-guess LAN IPv4 of this PC (skips loopback, Docker/WSL/VPN adapters). */
export function detectLanIP() {
  const skip = /(vEthernet|WSL|docker|br-|veth|virbr|vmnet|VirtualBox|Hyper-V|tailscale|zerotier|utun|Loopback)/i;
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue;
      candidates.push({ name, address: a.address, virtual: skip.test(name) });
    }
  }
  const preferred = candidates.find((c) => !c.virtual && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.address));
  return (preferred || candidates.find((c) => !c.virtual) || { address: "127.0.0.1" }).address;
}

/** A continuous 440 Hz sine WAV, used as fake microphone in Chromium. */
export function ensureToneWav() {
  const file = path.join(LAB_DIR, ".cache", "tone-440hz.wav");
  if (existsSync(file)) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  const rate = 48000;
  const seconds = 30;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5 * 32767), 44 + i * 2);
  }
  writeFileSync(file, buf);
  return file;
}

/**
 * Launch options for a lab browser. fakeMic=true feeds a test tone instead of
 * the real microphone and auto-grants permissions (no prompts).
 */
export function launchOptions(browserName, { fakeMic = true, headless = true } = {}) {
  const b = BROWSERS[browserName];
  if (!b) throw new Error(`unknown browser "${browserName}" (known: ${Object.keys(BROWSERS).join(", ")})`);
  const opts = { headless };
  if (b.channel) opts.channel = b.channel;
  if (b.type === "chromium") {
    opts.args = ["--autoplay-policy=no-user-gesture-required"];
    if (fakeMic) {
      opts.args.push(
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${ensureToneWav()}`,
      );
    }
  }
  if (b.type === "firefox") {
    opts.firefoxUserPrefs = {
      "media.autoplay.default": 0,
      "media.autoplay.blocking_policy": 0,
      // Allow ICE towards 127.0.0.1 when the lab advertises loopback.
      "media.peerconnection.ice.loopback": true,
      "media.peerconnection.ice.obfuscate_host_addresses": false,
      ...(fakeMic
        ? { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true }
        : { "media.navigator.permission.disabled": true }),
    };
  }
  return { type: b.type, options: opts };
}

/** Context options (mic permission comes from the launch flags/prefs above). */
export function contextOptions(_browserType) {
  return {};
}

/**
 * Init script: keeps a reference to every RTCPeerConnection the app creates
 * so tests can read WebRTC stats (the app does not expose its peer).
 */
export function peerCaptureScript() {
  const Orig = window.RTCPeerConnection;
  window.__labPeers = [];
  if (!Orig) return;
  window.RTCPeerConnection = class extends Orig {
    constructor(...args) {
      super(...args);
      window.__labPeers.push(this);
    }
  };
}

/** Logs a user in through the real login form and waits for the station view. */
export async function login(page, baseURL, { username, role }) {
  await page.goto(baseURL + "/");
  await page.getByLabel("Display name").fill(username);
  await page.getByLabel("Role").selectOption(role);
  await page.getByRole("button", { name: "Join Intercom" }).click();
  const takeover = page.getByRole("button", { name: "Confirm takeover" });
  const live = page.getByText(`Live: ${username.toUpperCase()}`);
  await takeover.or(live).first().waitFor({ timeout: 20_000 });
  if (await takeover.isVisible()) await takeover.click();
  await live.waitFor({ timeout: 20_000 });
}

/**
 * Makes sure the user listens to and/or talks on a party line (station card).
 * Defaults depend on stored settings, so tests set them explicitly.
 */
export async function setPartyLine(page, roomName, { listen, talk }) {
  const card = page.locator("article.station-card", { hasText: roomName }).first();
  await card.waitFor();
  const toggle = async (locator, pattern, want) => {
    const isSet = async () => pattern.test((await locator.getAttribute("class")) || "");
    // Retry: right after login the initial server state can still arrive and
    // overwrite an early click (noticeable on the high-latency profiles).
    for (let attempt = 0; attempt < 4 && (await isSet()) !== want; attempt++) {
      await locator.click();
      // Long enough for a round trip on the 'worst' profile (≈ 400 ms+).
      for (let i = 0; i < 60 && (await isSet()) !== want; i++) await page.waitForTimeout(100);
    }
    if ((await isSet()) !== want) throw new Error(`could not set ${pattern} to ${want} on party line ${roomName}`);
  };
  if (listen !== undefined) await toggle(card.locator("button.listen"), /(^|\s)on(\s|$)/, listen);
  if (talk !== undefined) await toggle(card.locator(".station-card-head").first(), /talk-armed/, talk);
}

/** Aggregated audio stats of all live peer connections on the page. */
export async function audioStats(page) {
  return page.evaluate(async () => {
    const out = {
      peers: 0,
      connected: 0,
      inPackets: 0,
      inLost: 0,
      inBytes: 0,
      jitterMs: 0,
      audioEnergy: 0,
      energyReported: false,
      samplesReceived: 0,
      concealedSamples: 0,
      jbDelay: 0,
      jbEmitted: 0,
      outPackets: 0,
      rttMs: null,
    };
    for (const pc of window.__labPeers || []) {
      if (pc.connectionState === "closed") continue;
      out.peers++;
      if (pc.connectionState === "connected") out.connected++;
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === "inbound-rtp" && (s.kind === "audio" || s.mediaType === "audio")) {
          out.inPackets += s.packetsReceived || 0;
          out.inLost += Math.max(0, s.packetsLost || 0);
          out.inBytes += s.bytesReceived || 0;
          out.jitterMs = Math.max(out.jitterMs, (s.jitter || 0) * 1000);
          if (s.totalAudioEnergy != null) {
            out.energyReported = true;
            out.audioEnergy += s.totalAudioEnergy;
          }
          out.samplesReceived += s.totalSamplesReceived || 0;
          out.concealedSamples += s.concealedSamples || 0;
          out.jbDelay += s.jitterBufferDelay || 0;
          out.jbEmitted += s.jitterBufferEmittedCount || 0;
        }
        if (s.type === "outbound-rtp" && (s.kind === "audio" || s.mediaType === "audio")) {
          out.outPackets += s.packetsSent || 0;
        }
        if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded" && s.currentRoundTripTime != null) {
          out.rttMs = Math.round(s.currentRoundTripTime * 1000);
        }
      });
    }
    return out;
  });
}

/** Difference of two audioStats snapshots → quality metrics for the window. */
export function audioDelta(before, after, seconds) {
  const packets = after.inPackets - before.inPackets;
  const lost = after.inLost - before.inLost;
  const samples = after.samplesReceived - before.samplesReceived;
  const concealed = after.concealedSamples - before.concealedSamples;
  const jbEmitted = after.jbEmitted - before.jbEmitted;
  return {
    seconds,
    packetsReceived: packets,
    packetsPerSecond: Math.round(packets / seconds),
    lossPct: packets + lost > 0 ? +((100 * lost) / (packets + lost)).toFixed(2) : 0,
    kbps: Math.round(((after.inBytes - before.inBytes) * 8) / seconds / 1000),
    jitterMs: +after.jitterMs.toFixed(1),
    concealedPct: samples > 0 ? +((100 * concealed) / samples).toFixed(2) : null,
    jitterBufferMs: jbEmitted > 0 ? Math.round((1000 * (after.jbDelay - before.jbDelay)) / jbEmitted) : null,
    audioEnergy: after.energyReported ? +(after.audioEnergy - before.audioEnergy).toFixed(4) : null,
    rttMs: after.rttMs,
  };
}
