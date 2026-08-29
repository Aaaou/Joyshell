import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceSessionHealthFailure,
  clearSessionHealthFailures,
  shouldSkipActiveLatencyProbe
} from "./latency-model.ts";

test("SSH health requires three consecutive failures", () => {
  const failures = {};

  assert.deepEqual(advanceSessionHealthFailure("session-a", failures), {
    failures: 1,
    shouldDisconnect: false
  });
  assert.deepEqual(advanceSessionHealthFailure("session-a", failures), {
    failures: 2,
    shouldDisconnect: false
  });
  assert.deepEqual(advanceSessionHealthFailure("session-a", failures), {
    failures: 3,
    shouldDisconnect: true
  });
});

test("real terminal activity resets SSH health failures", () => {
  const failures = { "session-a": 2 };

  clearSessionHealthFailures("session-a", failures);

  assert.deepEqual(advanceSessionHealthFailure("session-a", failures), {
    failures: 1,
    shouldDisconnect: false
  });
});

test("active terminal output suppresses a competing latency probe", () => {
  assert.equal(shouldSkipActiveLatencyProbe("session-a", 10_000, {
    lastInputAt: {},
    lastOutputAt: { "session-a": 9_500 },
    pendingInputAt: {}
  }), true);
  assert.equal(shouldSkipActiveLatencyProbe("session-a", 10_000, {
    lastInputAt: {},
    lastOutputAt: { "session-a": 1_000 },
    pendingInputAt: {}
  }), false);
});
