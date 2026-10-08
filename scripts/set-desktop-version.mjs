// Sets the desktop app version from a release tag before `tauri build`, so
// the installers carry the same version as the server and the Pi node.
// Without it every build says 0.1.0, and a Windows MSI only upgrades an
// existing installation when the version goes up.
//
//   node scripts/set-desktop-version.mjs v0.9.0   (or GITHUB_REF_NAME=v0.9.0)
//
// Anything that is not a plain vMAJOR.MINOR.PATCH tag (branch builds,
// pre-release tags, which MSI cannot represent) leaves the version alone.
import { readFileSync, writeFileSync } from "node:fs";

const ref = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const match = /^v(\d+\.\d+\.\d+)$/.exec(ref);
if (!match) {
  console.log(`desktop version: "${ref}" is not a release tag, keeping the version in tauri.conf.json`);
  process.exit(0);
}
const version = match[1];
const file = new URL("../desktop/src-tauri/tauri.conf.json", import.meta.url);
const conf = JSON.parse(readFileSync(file, "utf8"));
conf.version = version;
writeFileSync(file, JSON.stringify(conf, null, 2) + "\n");
console.log(`desktop version: ${version}`);
