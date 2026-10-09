// Lab server instances without Docker: builds the Go server once and runs
// one process per network profile. Network emulation is in-process
// (NETLAB_* env, backend/internal/app/emu_net.go), so this behaves like the
// Docker lab — minus Docker Desktop's UDP NAT, which itself adds latency and
// jitter on Windows/macOS. Preferred for latency measurements.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import path from "node:path";
import { LAB_DIR, ROOT_DIR, PROFILES } from "./lab.mjs";

const isWin = process.platform === "win32";
const CACHE = path.join(LAB_DIR, ".cache");
const BIN = path.join(CACHE, "bin", isWin ? "kesher-server.exe" : "kesher-server");
const PIDS = path.join(CACHE, "native-pids.json");
export const LOG_DIR = path.join(LAB_DIR, "results", "logs");

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: isWin, ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})`);
}

/** Builds the server binary; withUI also rebuilds and embeds the web UI. */
export function buildServer({ withUI }) {
  if (withUI) {
    console.log("lab: building web UI...");
    if (!existsSync(path.join(ROOT_DIR, "node_modules"))) run("npm", ["install", "--no-audit", "--no-fund"], { cwd: ROOT_DIR });
    run("npm", ["run", "build", "--workspace", "web"], { cwd: ROOT_DIR });
    const dst = path.join(ROOT_DIR, "backend", "internal", "app", "embedded_web");
    for (const name of readdirSync(dst)) if (name !== "_placeholder.txt") rmSync(path.join(dst, name), { recursive: true, force: true });
    cpSync(path.join(ROOT_DIR, "web", "dist"), dst, { recursive: true });
  }
  console.log("lab: building server...");
  mkdirSync(path.dirname(BIN), { recursive: true });
  run("go", ["build", "-o", BIN, "./cmd/server"], { cwd: path.join(ROOT_DIR, "backend") });
  return BIN;
}

function profileEnv(name, publicIP) {
  const p = PROFILES[name];
  const netem = Object.fromEntries(
    Object.entries(p.netem).map(([k, v]) => [`NETLAB_${k}`, String(process.env[`LAB_${name.toUpperCase()}_${k}`] ?? v)]),
  );
  const env = {
    ...process.env,
    APP_ADDR: `:${p.port}`,
    STATIC_DIR: "",
    DB_PATH: path.join(CACHE, "run", name, "lab.db"),
    TRUSTED_LAN_HTTP: "true",
    ALLOW_CORS: "false",
    ADMIN_PIN: process.env.ADMIN_PIN || "123456",
    LAB_MULTI_SESSION: "true",
    DISCONNECT_LOGOUT_DELAY_SECONDS: "5",
    UDP_AUDIO_ADDR: `:${p.nativePort}`,
    WEBRTC_UDP_PORT: String(p.webrtcPort),
    WEBRTC_PUBLIC_IPS: publicIP,
    ...netem,
  };
  // A config file would replace the whole env config; never pick one up.
  delete env.APP_CONFIG_FILE;
  delete env.CONFIG_FILE;
  delete env.UDP_AUDIO_ADVERTISE_IP;
  return env;
}

/**
 * Starts the given profiles. detached=true keeps them running after this
 * process exits (lab-up); stop with stopNative().
 */
export function startNative(profiles, { publicIP, detached = false }) {
  mkdirSync(LOG_DIR, { recursive: true });
  const children = [];
  for (const name of profiles) {
    const runDir = path.join(CACHE, "run", name);
    rmSync(runDir, { recursive: true, force: true }); // fresh DB per start
    mkdirSync(runDir, { recursive: true });
    const log = openSync(path.join(LOG_DIR, `server-${name}.log`), "w");
    const child = spawn(BIN, [], {
      cwd: runDir, // empty dir: no stray config.yaml
      env: profileEnv(name, publicIP),
      stdio: ["ignore", log, log],
      detached,
      windowsHide: true,
    });
    closeSync(log);
    if (detached) child.unref();
    children.push({ name, pid: child.pid, child });
  }
  if (detached) {
    const known = existsSync(PIDS) ? JSON.parse(readFileSync(PIDS, "utf8")) : {};
    for (const c of children) known[c.name] = c.pid;
    writeFileSync(PIDS, JSON.stringify(known, null, 2));
  }
  return children;
}

/** Stops processes started by startNative (children, or the detached ones). */
export function stopNative(children) {
  if (children) {
    for (const c of children) {
      try {
        c.child.kill();
      } catch {
        /* already gone */
      }
    }
    return;
  }
  if (!existsSync(PIDS)) return;
  for (const [name, pid] of Object.entries(JSON.parse(readFileSync(PIDS, "utf8")))) {
    try {
      process.kill(pid);
      console.log(`lab: stopped ${name} (pid ${pid})`);
    } catch {
      /* already gone */
    }
  }
  rmSync(PIDS, { force: true });
}
