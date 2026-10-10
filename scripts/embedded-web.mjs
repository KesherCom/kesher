// The server binary embeds backend/internal/app/embedded_web (go:embed).
// That folder is filled only for the duration of a build and emptied right
// after, so a later `go run` / `make dev-backend` never serves an old UI.
//
//   node scripts/embedded-web.mjs fill    copy web/dist in (after npm run build)
//   node scripts/embedded-web.mjs clear   back to just the placeholder
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dst = path.join(root, "backend", "internal", "app", "embedded_web");
const src = path.join(root, "web", "dist");

export function clearEmbeddedWeb() {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(dst)) {
    if (name !== "_placeholder.txt") rmSync(path.join(dst, name), { recursive: true, force: true });
  }
}

export function fillEmbeddedWeb() {
  if (!existsSync(path.join(src, "index.html"))) {
    throw new Error("web/dist is missing; run `npm run build --workspace web` first");
  }
  clearEmbeddedWeb();
  cpSync(src, dst, { recursive: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "fill") fillEmbeddedWeb();
  else if (command === "clear") clearEmbeddedWeb();
  else {
    console.error("usage: node scripts/embedded-web.mjs fill|clear");
    process.exit(2);
  }
}
