import type { SessionProfile } from "../../types";

const INTERACTIVE_LATENCY_IDLE_MS = 2500;
const TERMINAL_OUTPUT_BUSY_MS = 1200;
const INTERACTIVE_LATENCY_MAX_MS = 5000;
const INTERACTIVE_LATENCY_SAMPLE_LIMIT = 6;

export function resolveLatencyTarget(profile: SessionProfile | undefined) {
  if (!profile?.host || !profile.port) {
    return null;
  }
  return { host: profile.host, port: profile.port };
}

export function isLoopbackLatencyHost(host: string) {
  const value = host.trim().toLowerCase();
  return value === "localhost"
    || value === "::1"
    || value === "[::1]"
    || value === "0.0.0.0"
    || value.startsWith("127.");
}

export function shouldSkipActiveLatencyProbe(
  sessionId: string,
  now: number,
  refs: {
    lastInputAt: Record<string, number>;
    lastOutputAt: Record<string, number>;
    pendingInputAt: Record<string, number>;
  }
) {
  const pendingAt = refs.pendingInputAt[sessionId];
  if (pendingAt) {
    if (now - pendingAt <= INTERACTIVE_LATENCY_MAX_MS) {
      return true;
    }
    delete refs.pendingInputAt[sessionId];
  }
  const lastInputAt = refs.lastInputAt[sessionId] ?? 0;
  if (now - lastInputAt < INTERACTIVE_LATENCY_IDLE_MS) {
    return true;
  }
  const lastOutputAt = refs.lastOutputAt[sessionId] ?? 0;
  return now - lastOutputAt < TERMINAL_OUTPUT_BUSY_MS;
}

export function recordInteractiveLatencySample(
  sessionId: string,
  value: number,
  samplesBySession: Record<string, number[]>
) {
  const samples = [...(samplesBySession[sessionId] ?? []), value]
    .slice(-INTERACTIVE_LATENCY_SAMPLE_LIMIT);
  samplesBySession[sessionId] = samples;
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
}

export function averageLatencySamples(samples: number[] | undefined) {
  if (!samples?.length) {
    return null;
  }
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
}
