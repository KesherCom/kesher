#!/usr/bin/env node
// report.mjs — formats PROBEJSON lines (from docker compose logs of the
// netlab probes) into a human-readable table.
//
// Usage: node scripts/netlab/report.mjs <probes.log>
import { readFileSync } from "node:fs";

export function parseReports(filePath) {
  const text = readFileSync(filePath, "utf8");
  const reports = [];
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf("PROBEJSON ");
    if (idx < 0) continue;
    try {
      reports.push(JSON.parse(line.slice(idx + "PROBEJSON ".length)));
    } catch {
      /* ignore malformed lines */
    }
  }
  return reports;
}

function f1(v) {
  return (typeof v === "number" ? v.toFixed(1) : "n/a");
}

export function renderReports(reports) {
  const lines = [];
  const byInstance = new Map();
  for (const r of reports) {
    if (!byInstance.has(r.instance)) byInstance.set(r.instance, []);
    byInstance.get(r.instance).push(r);
  }
  const instances = [...byInstance.keys()].sort();
  if (instances.length === 0) {
    lines.push("(no probe reports found)");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("netlab audio quality report");
  lines.push("-".repeat(124));
  lines.push(
    [
      "instance".padEnd(12),
      "role".padEnd(5),
      "tpt".padEnd(7),
      "rtt_ms p50/p90".padEnd(14),
      "ctrl_ms p50".padEnd(11),
      "loss%".padEnd(7),
      "jit_ms".padEnd(7),
      "glitch@100ms%".padEnd(13),
      "score".padEnd(7),
      "setup_ms(offer->audio)".padEnd(22),
      "opus",
    ].join(""),
  );
  lines.push("-".repeat(124));

  let allOk = true;
  for (const inst of instances) {
    const rs = byInstance.get(inst);
    rs.sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : (a.transport || "webrtc") < (b.transport || "webrtc") ? -1 : 1));
    for (const r of rs) {
      const ok = r.ok && r.receive && r.receive.packets > 0;
      if (!ok) allOk = false;
      const setup = r.timings ? f1(r.timings.first_audio_ms) : "n/a";
      lines.push(
        [
          inst.padEnd(12),
          r.role.padEnd(5),
          (r.transport || "webrtc").padEnd(7),
          `${f1(r.ws_rtt_ms?.p50_ms)}/${f1(r.ws_rtt_ms?.p90_ms)}`.padEnd(14),
          f1(r.control_latency_ms?.p50_ms).padEnd(11),
          f1(r.receive?.lost_pct).padEnd(7),
          f1(r.receive?.jitter_ms).padEnd(7),
          f1(r.receive?.playout_glitch_pct?.["buf100ms"]).padEnd(13),
          (r.quality_score ?? "n/a").toString().padEnd(7),
          setup.padEnd(22),
          r.opus === false ? "no" : "yes",
        ].join(""),
      );
      if (r.error) lines.push(`  ! ${r.instance}/${r.role}/${r.transport || "webrtc"}: ${r.error}`);
    }
    const srv = rs.find((r) => r.server?.hub);
    if (srv?.server) {
      const s = srv.server;
      const hub = s.hub || {};
      const med = s.media || {};
      lines.push(
        `  server: clients=${hub.connectedClients ?? "n/a"} queueMax=${hub.normalQueueDepthMax ?? "n/a"}/${hub.priorityQueueDepthMax ?? "n/a"} dropped=${(hub.droppedCriticalMessages ?? 0) + (hub.droppedNormalMessages ?? 0)} syncRunAvg=${med.syncRunAvgMs ?? "n/a"}ms reneg=${med.renegotiations ?? "n/a"}`,
      );
    }
  }
  lines.push("-".repeat(118));
  const recv = reports.filter((r) => r.receive?.packets > 0).length;
  lines.push(`probes: ${recv}/${reports.length} reported audio`);
  lines.push("");
  return { text: lines.join("\n"), allOk };
}
