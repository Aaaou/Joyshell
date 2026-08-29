import assert from "node:assert/strict";
import test from "node:test";

import {
  isRecoverableTransferFailure,
  isScheduledTransferRetryCurrent,
  recoverableTransferFailureReason
} from "./transfer-retry-model.ts";

function transfer(status, retryCount = 0) {
  return {
    id: "transfer-a",
    session_id: "session-a",
    profile_id: "profile-a",
    direction: "Upload",
    local_path: "C:/source.bin",
    remote_path: "/tmp/source.bin",
    bytes_done: 0,
    bytes_total: 1024,
    status,
    retry_count: retryCount
  };
}

test("automatic transfer retry accepts only transport failures", () => {
  const failed = transfer({ Failed: { reason: "socket connection timed out" } });
  assert.equal(isRecoverableTransferFailure(recoverableTransferFailureReason(failed)), true);
  assert.equal(isRecoverableTransferFailure("permission denied"), false);
  assert.equal(isRecoverableTransferFailure("应用已重启，重新连接服务器后可继续传输"), true);
});

test("scheduled retry becomes invalid after cancellation or generation change", () => {
  const retrying = transfer({ Retrying: { attempt: 3, max_attempts: 5, reason: "timeout" } }, 2);
  assert.equal(isScheduledTransferRetryCurrent(retrying, 2), true);
  assert.equal(isScheduledTransferRetryCurrent({ ...retrying, status: "Cancelled" }, 2), false);
  assert.equal(isScheduledTransferRetryCurrent(retrying, 1), false);
});
