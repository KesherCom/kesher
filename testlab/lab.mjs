#!/usr/bin/env node
// kesher test lab CLI — see testlab/README.md.
//
//   node testlab/lab.mjs all      everything in one go: build, start servers, desktop
//                                 audio benchmark, browser matrix, stop (make lab)
//   node testlab/lab.mjs desktop  desktop-app latency/quality benchmark (make lab-desktop)
//   node testlab/lab.mjs up       build + start the lab servers and keep them running
//   node testlab/lab.mjs status   show instances, URLs and health
//   node testlab/lab.mjs test     run the Playwright matrix (browsers × profiles)
//   node testlab/lab.mjs open     open real browser windows, logged in, for manual testing
//   node testlab/lab.mjs down     stop the lab and delete its data
//
// Servers run as local processes by default; LAB_RUNTIME=docker uses
// deploy/compose/docker-compose.lab.yml instead (up/down only).
//
// Options for `desktop`/`all`: --profiles lan,wan --frames 2.5,5,10 --seconds 20
//                       --hardware --save-baseline --strict --no-build
// Options for `open`:   --browsers chromium,firefox  --profile wan  --real-mic
//                       --roles audio,producer,video   --users 3
// Options for `test`:   anything after `--` goes to `playwright test`, e.g.
//                       node testlab/lab.mjs test -- -g "same browser" --headed
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  LAB_DIR,
  ROOT_DIR,
  PROFILES,
  BROWSERS,
  profileURL,
  detectLanIP,
  listFromEnv,
  launchOptions,
  contextOptions,
  login,
} from "./lib/lab.mjs";
import { buildServer, startNative, stopNative } from "./lib/instances.mjs";
import { runDesktop } from "./lib/desktop.mjs";

const COMPOSE = path.join(ROOT_DIR, "deploy", "compose", "docker-compose.lab.yml");
const isWin = process.platform === "win32";
const DOCKER = (process.env.LAB_RUNTIME || "native") === "docker";

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: isWin, ...opts });
  if (res.error) {
    console.error(`lab: failed to run ${cmd}: ${res.error.message}`);
    process.exit(1);
  }
  return res;
}

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

function publicIP() {
  return process.env.LAB_PUBLIC_IP || detectLanIP();
}

function compose(args, opts = {}) {
  return sh("docker", ["compose", "-f", COMPOSE, ...args], {
    env: { ...process.env, LAB_PUBLIC_IP: publicIP() },
    ...opts,
  });
}

function ensureDeps() {
  if (!existsSync(path.join(LAB_DIR, "node_modules", "@playwright", "test"))) {
    console.log("lab: installing testlab dependencies (first run)...");
    if (sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: LAB_DIR }).status !== 0) process.exit(1);
  }
}

function ensureBrowsers(names) {
  const engines = [...new Set(names.filter((n) => !BROWSERS[n]?.channel).map((n) => BROWSERS[n]?.type).filter(Boolean))];
  if (engines.length === 0) return;
  // Idempotent and fast when already installed.
  sh("npx", ["playwright", "install", ...engines], { cwd: LAB_DIR });
}

async function health(url) {
  try {
    const res = await fetch(`${url}/api/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(profiles, timeoutSec = 300) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const states = await Promise.all(profiles.map((p) => health(profileURL(p))));
    if (states.every(Boolean)) return true;
    process.stdout.write(`lab: waiting for instances (${states.filter(Boolean).length}/${profiles.length} healthy)...\r`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error("\nlab: timeout waiting for instances — check `docker compose -f deploy/compose/docker-compose.lab.yml logs`");
  return false;
}

async function status() {
  const ip = publicIP();
  console.log("");
  console.log("kesher test lab");
  console.log("profile  healthy  this PC                  other LAN devices        network");
  for (const [name, p] of Object.entries(PROFILES)) {
    const ok = (await health(profileURL(name))) ? "yes" : "no ";
    console.log(
      `${name.padEnd(8)} ${ok.padEnd(8)} ${profileURL(name).padEnd(24)} ${`http://${ip}:${p.port}`.padEnd(24)} ${p.desc}`,
    );
  }
  console.log("");
  console.log(`Advertised media IP: ${ip}  (override with LAB_PUBLIC_IP=...)`);
  console.log("Microphones only work on http:// for localhost/127.0.0.1 — other devices need the desktop app or HTTPS.");
  console.log("");
}

async function up() {
  const ip = publicIP();
  if (DOCKER) {
    console.log(`lab: building and starting Docker instances (media IP ${ip}; first build takes a few minutes)...`);
    if (compose(["up", "-d", "--build", "--wait"]).status !== 0) {
      console.error("lab: docker compose failed. Is Docker Desktop running?");
      process.exit(1);
    }
  } else {
    stopNative();
    buildServer({ withUI: true });
    startNative(Object.keys(PROFILES), { publicIP: ip, detached: true });
  }
  await waitHealthy(Object.keys(PROFILES));
  await status();
}

function down() {
  stopNative();
  if (DOCKER) compose(["down", "-v", "--remove-orphans"]);
}

/** make lab: the complete setup in one command. */
async function all(flags, rest) {
  const profiles = Object.keys(PROFILES);
  const results = [];
  let children = null;
  try {
    ensureDeps();
    if (!flags["no-build"]) buildServer({ withUI: true });
    if (!(await waitHealthy(profiles, 1))) {
      children = startNative(profiles, { publicIP: publicIP() });
      if (!(await waitHealthy(profiles, 30))) throw new Error("lab servers did not start — see testlab/results/logs");
    }
    console.log("\n=== 1/2 Desktop app: latency and audio quality ===");
    results.push(["desktop audio benchmark", await runDesktop({ ...flags, "no-build": false })]);
    if (!flags["no-browser"]) {
      console.log("\n=== 2/2 Browsers × networks (Playwright) ===");
      const browsers = listFromEnv("LAB_BROWSERS", ["chromium", "firefox", "webkit"]);
      ensureBrowsers([...browsers, "chromium", "firefox"]);
      // "worst" is excluded by default: browser setup over a 380 ms / 5 % loss
      // link is not reliable yet (see testlab/README.md, known issues).
      const env = { ...process.env, LAB_PROFILES: process.env.LAB_PROFILES || "lan,wifi,wan" };
      const res = sh("npx", ["playwright", "test", ...rest], { cwd: LAB_DIR, env });
      results.push([`browser matrix (${env.LAB_PROFILES})`, res.status === 0]);
    }
  } finally {
    if (children) stopNative(children);
  }
  console.log("\n=== Summary ===");
  for (const [name, ok] of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  process.exitCode = results.every(([, ok]) => ok) ? 0 : 1;
}

async function test(rest) {
  ensureDeps();
  const browsers = listFromEnv("LAB_BROWSERS", ["chromium", "firefox", "webkit"]);
  const profiles = listFromEnv("LAB_PROFILES", Object.keys(PROFILES));
  ensureBrowsers([...browsers, "chromium", "firefox"]); // cross-browser partners
  if (!(await waitHealthy(profiles, 5))) {
    console.error(`lab: instances not reachable (${profiles.join(", ")}). Start them with: make lab-up`);
    process.exit(1);
  }
  const res = sh("npx", ["playwright", "test", ...rest], { cwd: LAB_DIR });
  process.exitCode = res.status ?? 1;
}

async function open(flags) {
  ensureDeps();
  const browsers = String(flags.browsers || "chromium,firefox").split(",").filter(Boolean);
  const profile = String(flags.profile || "lan");
  const roles = String(flags.roles || "audio,producer,video,lighting,camera,pastor").split(",");
  const perBrowser = Number(flags.users || 1);
  const realMic = Boolean(flags["real-mic"]);
  ensureBrowsers(browsers);
  const baseURL = profileURL(profile);
  if (!(await health(baseURL))) {
    console.error(`lab: ${baseURL} is not reachable. Start the lab first: make lab-up`);
    process.exit(1);
  }

  const { chromium, firefox, webkit } = await import("@playwright/test");
  const engines = { chromium, firefox, webkit };
  const opened = [];
  let n = 0;
  for (const name of browsers) {
    const { type, options } = launchOptions(name, { fakeMic: !realMic, headless: false });
    const browser = await engines[type].launch(options);
    opened.push(browser);
    for (let i = 0; i < perBrowser; i++) {
      const role = roles[n % roles.length];
      const username = `${name}${i + 1}`;
      n++;
      const page = await (await browser.newContext({ ...contextOptions(type), viewport: null })).newPage();
      try {
        await login(page, baseURL, { username, role });
        console.log(`lab: ${name} window ${i + 1} → ${username} (${role}) on ${profile}`);
      } catch (err) {
        console.warn(`lab: auto-login failed in ${name} (${String(err).split("\n")[0]}) — log in manually`);
      }
    }
  }
  console.log("");
  console.log(realMic ? "lab: real microphones in use — use headphones to avoid feedback." : "lab: fake microphones send a 440 Hz test tone (use --real-mic for your mic).");
  console.log("lab: hold 'Hold to talk' (or Space) in one window, listen in the others. Ctrl+C closes everything.");
  const closeAll = async () => {
    await Promise.allSettled(opened.map((b) => b.close()));
    process.exit(0);
  };
  process.on("SIGINT", closeAll);
  process.on("SIGTERM", closeAll);
  await Promise.all(opened.map((b) => new Promise((r) => b.on("disconnected", r))));
}

const [mode = "status", ...argv] = process.argv.slice(2);
const { flags, rest } = parseArgs(argv);
switch (mode) {
  case "up":
    await up();
    break;
  case "down":
    down();
    break;
  case "status":
    await status();
    break;
  case "test":
    await test(rest);
    break;
  case "open":
    await open(flags);
    break;
  case "desktop":
    try {
      process.exitCode = (await runDesktop(flags)) ? 0 : 1;
    } catch (err) {
      console.error(`lab: ${err.message || err}`);
      process.exitCode = 1;
    }
    break;
  case "all":
    await all(flags, rest);
    break;
  default:
    console.error(`lab: unknown command "${mode}" (all | desktop | up | status | test | open | down)`);
    process.exit(2);
}
