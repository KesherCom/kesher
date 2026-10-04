// Playwright reporter: collects the "audio-metrics" attachments written by
// tests/audio.spec.ts and prints one comparison table at the end. The raw
// rows are also saved to testlab/results/audio-<timestamp>.json.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LAB_DIR } from "./lab.mjs";

const COLUMNS = [
  ["path", 34],
  ["status", 7],
  ["pkt/s", 6],
  ["loss%", 6],
  ["conceal%", 9],
  ["jitter", 7],
  ["jbuf", 6],
  ["rtt", 5],
  ["kbps", 5],
];

export default class AudioReporter {
  constructor() {
    this.rows = [];
  }

  onTestEnd(test, result) {
    for (const a of result.attachments) {
      if (a.name !== "audio-metrics" || !a.body) continue;
      try {
        this.rows.push({ ...JSON.parse(a.body.toString()), status: result.status });
      } catch {
        /* ignore malformed attachment */
      }
    }
  }

  onEnd() {
    if (this.rows.length === 0) return;
    const fmt = (v, w) => String(v ?? "–").padEnd(w);
    const lines = [];
    lines.push("");
    lines.push("Audio quality (listener side, while the talker holds PTT)");
    lines.push(COLUMNS.map(([n, w]) => fmt(n, w)).join(" "));
    lines.push(COLUMNS.map(([, w]) => "-".repeat(w)).join(" "));
    for (const r of this.rows) {
      const m = r.metrics || {};
      lines.push(
        [
          fmt(`${r.talker} → ${r.listener} @${r.profile}`, 34),
          fmt(r.status, 7),
          fmt(m.packetsPerSecond, 6),
          fmt(m.lossPct, 6),
          fmt(m.concealedPct, 9),
          fmt(m.jitterMs != null ? `${m.jitterMs}ms` : null, 7),
          fmt(m.jitterBufferMs != null ? `${m.jitterBufferMs}ms` : null, 6),
          fmt(m.rttMs != null ? `${m.rttMs}ms` : null, 5),
          fmt(m.kbps, 5),
        ].join(" "),
      );
    }
    lines.push("");
    lines.push("pkt/s ≈ 50 (20 ms Opus) or 100 (10 ms) when audio flows. conceal% = audio the");
    lines.push("receiver had to invent (PLC) — the most direct 'sounds bad' number. jbuf = average");
    lines.push("jitter-buffer delay, a large part of mouth-to-ear latency. '–' = not reported by browser.");
    console.log(lines.join("\n"));

    const dir = path.join(LAB_DIR, "results");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `audio-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
    writeFileSync(file, JSON.stringify(this.rows, null, 2));
    console.log(`Saved: ${path.relative(process.cwd(), file)}\n`);
  }

  printsToStdio() {
    return false;
  }
}
