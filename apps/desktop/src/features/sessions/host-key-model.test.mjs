import assert from "node:assert/strict";
import test from "node:test";

import { enqueueHostKeyPrompt, removeHostKeyPrompt } from "./host-key-model.ts";

function prompt(token, sessionId) {
  return {
    token,
    session_id: sessionId,
    profile_id: sessionId,
    host: "example.internal",
    port: 22,
    key_type: "ssh-ed25519",
    key_base64: "AQ==",
    fingerprint: `SHA256:${token}`,
    reason: "unknown",
    created_at: new Date(0).toISOString()
  };
}

test("host key prompt queue keeps concurrent sessions separate", () => {
  const first = prompt("token-a", "session-a");
  const second = prompt("token-b", "session-b");
  const queue = enqueueHostKeyPrompt(enqueueHostKeyPrompt([], first), second);
  assert.deepEqual(queue.map((item) => item.session_id), ["session-a", "session-b"]);
  assert.deepEqual(removeHostKeyPrompt(queue, "token-a"), [second]);
});

test("host key prompt queue ignores duplicate tokens", () => {
  const item = prompt("token-a", "session-a");
  const queue = enqueueHostKeyPrompt([item], { ...item, session_id: "wrong-session" });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].session_id, "session-a");
});
