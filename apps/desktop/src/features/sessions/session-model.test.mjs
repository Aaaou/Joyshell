import assert from "node:assert/strict";
import test from "node:test";

import { resolveProfileDoubleClickDecision } from "./session-model.ts";

test("connected profile opens its earliest connected shell by default", () => {
  const decision = resolveProfileDoubleClickDecision({
    profileId: "profile-a",
    openShellIds: ["shell-old", "shell-new"],
    shellProfileIds: {
      "shell-old": "profile-a",
      "shell-new": "profile-a"
    },
    connectedSessionIds: new Set(["shell-old", "shell-new"]),
    action: "open_earliest"
  });

  assert.deepEqual(decision, { kind: "activate", shellId: "shell-old" });
});

test("connected profile can request a new independent SSH session", () => {
  const decision = resolveProfileDoubleClickDecision({
    profileId: "profile-a",
    openShellIds: ["shell-old"],
    shellProfileIds: { "shell-old": "profile-a" },
    connectedSessionIds: new Set(["shell-old"]),
    action: "new_session"
  });

  assert.deepEqual(decision, { kind: "create" });
});

test("disconnected profile reuses its existing shell tab", () => {
  const decision = resolveProfileDoubleClickDecision({
    profileId: "profile-a",
    openShellIds: ["shell-existing"],
    shellProfileIds: { "shell-existing": "profile-a" },
    connectedSessionIds: new Set(),
    action: "open_earliest"
  });

  assert.deepEqual(decision, { kind: "connect", shellId: "shell-existing" });
});
