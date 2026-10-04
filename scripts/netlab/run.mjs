#!/usr/bin/env node
// run.mjs — orchestrates the kesher netlab test lab.
//
// Modes:
//   run     (default) one-shot: generate -> build -> up -> wait -> collect
//           probe reports -> print table -> down. Exit code reflects results.
//   up      keep the stack running for manual testing (Tauri app, browsers).
//   report  collect probe reports from the running stack and print the table.
//   down    stop and remove the stack (including volumes).
//
// Configuration via NETLAB_* env vars (see generate.mjs); zero-config
// defaults are fine: `make nettest`.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReports, renderReports } from "./report.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE = path.join(ROOT, "deploy", "compose", "docker-compose.netlab.yml");

const envNum = (key, fallback) => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
const INSTANCES = envNum("NETLAB_INSTANCES", 3);
const DURATION = envNum("NETLAB_DURATION_SECONDS", 30);
const PORT_BASE = envNum("NETLAB_PORT_BASE", 39080);

const mode = process.argv[2] || "run";

// Cross-platform blocking sleep (the old PowerShell call only worked on Windows).
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (res.error) {
    console.error(`netlab: failed to run ${cmd}: ${res.error.message}`);
    process.exit(1);
  }
  return res;
}

function compose(args, opts = {}) {
  return run("docker", ["compose", "-f", COMPOSE, ...args], opts);
}

function printUrls() {
  console.log("");
  console.log("netlab instances (connect clients / Tauri app here):");
  for (let i = 1; i <= INSTANCES; i++) {
    console.log(`  http://127.0.0.1:${PORT_BASE + i - 1}  (instance-${i})`);
  }
  console.log("");
  console.log("Tauri/manual testing: point the app's server URL at one of the");
  console.log("addresses above. Traffic is emulated in-process by the instances (delay/loss/jitter).");
  console.log("These instances have no web UI — for browsers use the test lab: make lab-up / make lab-open.");
  console.log("Headless probes measure the WebRTC (browser) and native UDP (Tauri) audio paths");
  console.log("side by side; `make netlab-report` shows their results.");
}

function composePS() {
  const res = compose(["ps", "--all", "--format", "json"], { stdio: ["ignore", "pipe", "inherit"] });
  const entries = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) entries.push(...parsed);
      else entries.push(parsed);
    } catch {
      /* ignore non-JSON lines */
    }
  }
  return entries;
}

function waitInstancesHealthy(timeoutSec = 300) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const entries = composePS();
    const instances = entries.filter((e) => String(e.Service || e.Name || "").startsWith("instance-"));
    const allHealthy =
      instances.length === INSTANCES &&
      instances.every((e) => e.Health === "healthy" || e.State === "running");
    if (allHealthy) return entries;
    process.stdout.write(`netlab: waiting for ${instances.length}/${INSTANCES} instances healthy...\r`);
    sleepSync(2500);
  }
  console.error("\nnetlab: timeout waiting for instances to become healthy");
  process.exit(1);
}

function waitProbesExited(timeoutSec = 600) {
  const deadline = Date.now() + timeoutSec * 1000;
  const expected = new Set();
  for (let i = 1; i <= INSTANCES; i++) {
    for (const role of ["a", "b"]) {
      expected.add(`probe-${i}-${role}`);
      expected.add(`probe-${i}-${role}-native`);
    }
  }
  while (Date.now() < deadline) {
    const entries = composePS();
    const byName = new Map(entries.map((e) => [e.Service || e.Name || "", e]));
    const missing = [...expected].filter((n) => !byName.has(n) || (byName.get(n).State || "") !== "exited");
    if (missing.length === 0) return true;
    const states = [...expected].map((n) => {
      const e = byName.get(n);
      return `${n}=${e ? e.State || "?" : "?"}`;
    });
    process.stdout.write(`netlab: waiting for probes (${missing.length}/${expected.size} running)... [${states.join(", ")}]\r`);
    sleepSync(2500);
  }
  console.error("\nnetlab: timeout waiting for probes to finish");
  return false;
}

function collectReports() {
  const names = [];
  for (let i = 1; i <= INSTANCES; i++) {
    for (const role of ["a", "b"]) {
      names.push(`probe-${i}-${role}`, `probe-${i}-${role}-native`);
    }
  }
  const res = compose(["logs", "--no-color", "--no-log-prefix", ...names], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const dir = path.join(ROOT, "netlab-results");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `probes-${ts}.log`);
  writeFileSync(file, res.stdout, "utf8");
  console.log(`netlab: probe logs saved to ${path.relative(ROOT, file)}`);
  return file;
}

function showReport(file) {
  const reports = parseReports(file);
  const { text, allOk } = renderReports(reports);
  console.log(text);
  return allOk;
}

function latestLogFile() {
  const dir = path.join(ROOT, "netlab-results");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith("probes-") && f.endsWith(".log"));
  if (files.length === 0) return null;
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

function generate() {
  return run("node", [path.join(ROOT, "scripts", "netlab", "generate.mjs")], { stdio: "inherit" });
}

function up() {
  generate();
  console.log("netlab: building and starting stack (first build takes a few minutes)...");
  compose(["up", "-d", "--build"], { stdio: "inherit" });
  waitInstancesHealthy();
  printUrls();
  console.log(`netlab: probes measuring for ${DURATION}s each; once they exit run: make netlab-report`);
}

function down() {
  console.log("netlab: stopping stack (removing volumes)...");
  compose(["down", "-v"], { stdio: "inherit" });
  console.log("netlab: stack stopped");
}

function report() {
  const file = latestLogFile();
  if (!file) {
    console.error("netlab: no saved probe logs found. Start the stack first (make netlab-up).");
    process.exit(1);
  }
  const allOk = showReport(file);
  process.exitCode = allOk ? 0 : 1;
}

function fullRun() {
  generate();
  console.log("netlab: building and starting stack (first build takes a few minutes)...");
  compose(["up", "-d", "--build"], { stdio: "inherit" });
  waitInstancesHealthy();
  printUrls();
  const ok = waitProbesExited(DURATION + 600);
  const file = collectReports();
  const allOk = showReport(file) && ok;
  console.log("netlab: tearing down stack...");
  compose(["down", "-v"], { stdio: "inherit" });
  if (ok) {
    console.log("netlab: done. Tune the network via NETLAB_* env vars, e.g.:");
    console.log("  make nettest NETLAB_LATENCY_MS=80 NETLAB_LOSS_PCT=3 NETLAB_INSTANCES=4");
  }
  process.exitCode = allOk ? 0 : 1;
}

switch (mode) {
  case "up":
    up();
    break;
  case "down":
    down();
    break;
  case "report":
    report();
    break;
  case "run":
  default:
    fullRun();
    break;
}
