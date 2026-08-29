import assert from "node:assert/strict";
import test from "node:test";

import { resolveTerminalBatch, resolveTerminalEvent } from "./terminal-output-sequence.ts";

const output = (sequence, data = String(sequence)) => ({ session_id: "session-a", sequence, data });

test("terminal events accept only the next sequence", () => {
  assert.deepEqual(resolveTerminalEvent(4, output(5, "next")), {
    cursor: 5, data: "next", initialize: false, truncated: false
  });
  assert.equal(resolveTerminalEvent(5, output(5)), null);
  assert.equal(resolveTerminalEvent(5, output(7)), null);
  assert.equal(resolveTerminalEvent(undefined, output(1)), null);
});

test("initial terminal batch establishes the cursor and output", () => {
  assert.deepEqual(resolveTerminalBatch(undefined, {
    session_id: "session-a", first_sequence: 3, latest_sequence: 4, truncated: false, outputs: [output(3), output(4)]
  }), { cursor: 4, data: "34", initialize: true, truncated: false });
});

test("terminal batch skips duplicates and fills a sequence gap", () => {
  assert.deepEqual(resolveTerminalBatch(4, {
    session_id: "session-a", first_sequence: 3, latest_sequence: 7, truncated: false,
    outputs: [output(4), output(5), output(6), output(7)]
  }), { cursor: 7, data: "567", initialize: false, truncated: false });
});

test("terminal batch reports a cursor older than retained output", () => {
  assert.deepEqual(resolveTerminalBatch(2, {
    session_id: "session-a", first_sequence: 10, latest_sequence: 11, truncated: true, outputs: [output(10), output(11)]
  }), { cursor: 11, data: "1011", initialize: false, truncated: true });
});
