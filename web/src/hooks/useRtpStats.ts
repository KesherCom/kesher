/**
 * Tracks inbound/outbound RTP byte-rate statistics from a WebRTC peer connection.
 *
 * Call `startStatsLoop(pc)` once the peer connection is ready and
 * `stopStatsLoop()` on teardown. The result `rtpStats` is safe to display only
 * when `showDebug` is true – callers gate the start call accordingly.
 */
import { useRef, useState } from "react";

export type RtpStats = {
  inKbps: number;
  outKbps: number;
  jitterMs: number;
  roundTripMs: number;
  playoutDelayMs: number;
};

type AudioRemoteInboundStats = RTCStats & {
  kind?: string;
  roundTripTime?: number;
};

export function useRtpStats() {
  const [rtpStats, setRtpStats] = useState<RtpStats>({
    inKbps: 0,
    outKbps: 0,
    jitterMs: 0,
    roundTripMs: 0,
    playoutDelayMs: 0,
  });
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
    setRtpStats({
      inKbps: 0,
      outKbps: 0,
      jitterMs: 0,
      roundTripMs: 0,
      playoutDelayMs: 0,
    });
  }

  function startStatsLoop(pc: RTCPeerConnection) {
    stopStatsLoop();
    statsIntervalRef.current = window.setInterval(() => {
      void (async () => {
        const report = await pc.getStats();
        let inBytes = 0;
        let outBytes = 0;
        let inboundJitterSecTotal = 0;
        let inboundJitterCount = 0;
        let remoteRoundTripSecTotal = 0;
        let remoteRoundTripCount = 0;
        let selectedPairRoundTripSec = 0;
        let hasSelectedPairRoundTrip = false;
        let jitterBufferDelaySecTotal = 0;
        let jitterBufferEmittedCountTotal = 0;
        report.forEach((s) => {
          if (
            s.type === "inbound-rtp" &&
            (s as RTCInboundRtpStreamStats).kind === "audio"
          ) {
            const inbound = s as RTCInboundRtpStreamStats & {
              jitterBufferDelay?: number;
              jitterBufferEmittedCount?: number;
            };
            inBytes += inbound.bytesReceived || 0;
            if (typeof inbound.jitter === "number") {
              inboundJitterSecTotal += inbound.jitter;
              inboundJitterCount += 1;
            }
            if (
              typeof inbound.jitterBufferDelay === "number" &&
              typeof inbound.jitterBufferEmittedCount === "number"
            ) {
              jitterBufferDelaySecTotal += inbound.jitterBufferDelay;
              jitterBufferEmittedCountTotal += inbound.jitterBufferEmittedCount;
            }
          }
          if (
            s.type === "outbound-rtp" &&
            (s as RTCOutboundRtpStreamStats).kind === "audio"
          ) {
            outBytes += (s as RTCOutboundRtpStreamStats).bytesSent || 0;
          }
          if (s.type === "remote-inbound-rtp") {
            const remoteInbound = s as AudioRemoteInboundStats;
            if (
              remoteInbound.kind === "audio" &&
              typeof remoteInbound.roundTripTime === "number"
            ) {
              remoteRoundTripSecTotal += remoteInbound.roundTripTime;
              remoteRoundTripCount += 1;
            }
          }
          if (s.type === "candidate-pair") {
            const candidatePair = s as RTCStats & {
              state?: string;
              nominated?: boolean;
              currentRoundTripTime?: number;
            };
            if (
              candidatePair.state === "succeeded" &&
              candidatePair.nominated === true &&
              typeof candidatePair.currentRoundTripTime === "number"
            ) {
              selectedPairRoundTripSec = candidatePair.currentRoundTripTime;
              hasSelectedPairRoundTrip = true;
            }
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
        const jitterMs =
          inboundJitterCount > 0
            ? (inboundJitterSecTotal / inboundJitterCount) * 1000
            : 0;
        const roundTripMs =
          remoteRoundTripCount > 0
            ? (remoteRoundTripSecTotal / remoteRoundTripCount) * 1000
            : hasSelectedPairRoundTrip
              ? selectedPairRoundTripSec * 1000
              : 0;
        const playoutDelayMs =
          jitterBufferEmittedCountTotal > 0
            ? (jitterBufferDelaySecTotal / jitterBufferEmittedCountTotal) * 1000
            : 0;
        lastStatsRef.current = { ts: now, inBytes, outBytes };
        setRtpStats({
          inKbps: Math.max(0, Math.round(inKbps)),
          outKbps: Math.max(0, Math.round(outKbps)),
          jitterMs: Math.max(0, Math.round(jitterMs)),
          roundTripMs: Math.max(0, Math.round(roundTripMs)),
          playoutDelayMs: Math.max(0, Math.round(playoutDelayMs)),
        });
      })().catch(() => undefined);
    }, 1000);
  }

  return { rtpStats, startStatsLoop, stopStatsLoop };
}
