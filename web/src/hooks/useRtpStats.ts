/**
 * Tracks inbound/outbound RTP byte-rate statistics from a WebRTC peer connection.
 *
 * Call `startStatsLoop(pc)` once the peer connection is ready and
 * `stopStatsLoop()` on teardown. The result `rtpStats` is safe to display only
 * when `showDebug` is true – callers gate the start call accordingly.
 */
import { useRef, useState } from "react";

export type RtpStats = { inKbps: number; outKbps: number };

export function useRtpStats() {
  const [rtpStats, setRtpStats] = useState<RtpStats>({ inKbps: 0, outKbps: 0 });
  const statsIntervalRef = useRef<number | null>(null);
  const lastStatsRef = useRef<{
    ts: number;
    inBytes: number;
    outBytes: number;
  } | null>(null);

  function stopStatsLoop() {
    if (statsIntervalRef.current !== null) {
      window.clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    lastStatsRef.current = null;
    setRtpStats({ inKbps: 0, outKbps: 0 });
  }

  function startStatsLoop(pc: RTCPeerConnection) {
    stopStatsLoop();
    statsIntervalRef.current = window.setInterval(() => {
      void (async () => {
        const report = await pc.getStats();
        let inBytes = 0;
        let outBytes = 0;
        report.forEach((s) => {
          if (
            s.type === "inbound-rtp" &&
            (s as RTCInboundRtpStreamStats).kind === "audio"
          ) {
            inBytes += (s as RTCInboundRtpStreamStats).bytesReceived || 0;
          }
          if (
            s.type === "outbound-rtp" &&
            (s as RTCOutboundRtpStreamStats).kind === "audio"
          ) {
            outBytes += (s as RTCOutboundRtpStreamStats).bytesSent || 0;
          }
        });
        const now = Date.now();
        const prev = lastStatsRef.current;
        if (!prev) {
          lastStatsRef.current = { ts: now, inBytes, outBytes };
          return;
        }
        const dtSec = (now - prev.ts) / 1000;
        if (dtSec <= 0) return;
        const inKbps = ((inBytes - prev.inBytes) * 8) / 1000 / dtSec;
        const outKbps = ((outBytes - prev.outBytes) * 8) / 1000 / dtSec;
        lastStatsRef.current = { ts: now, inBytes, outBytes };
        setRtpStats({
          inKbps: Math.max(0, Math.round(inKbps)),
          outKbps: Math.max(0, Math.round(outKbps)),
        });
      })().catch(() => undefined);
    }, 1000);
  }

  return { rtpStats, startStatsLoop, stopStatsLoop };
}
