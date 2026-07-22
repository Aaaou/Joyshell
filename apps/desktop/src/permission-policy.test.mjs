import assert from "node:assert/strict";
import test from "node:test";

function decide({ assistant, toolName }) {
  if (assistant.disallowedTools.includes(toolName)) {
    return "Deny";
  }
  if (!assistant.allowedTools.includes("*") && !assistant.allowedTools.includes(toolName)) {
    return "Deny";
  }
  if (toolName.includes("read") || toolName === "session.get_info" || toolName === "memory.search") {
    return "Allow";
  }
  return "Ask";
}

test("read-only assistant cannot execute terminal commands", () => {
  const assistant = {
    allowedTools: ["terminal.read_output", "session.get_info", "memory.search"],
    disallowedTools: ["terminal.run_command"]
  };
  assert.equal(decide({ assistant, toolName: "terminal.run_command" }), "Deny");
});

test("general assistant asks before command execution", () => {
  const assistant = {
    allowedTools: ["*"],
    disallowedTools: []
  };
  assert.equal(decide({ assistant, toolName: "terminal.run_command" }), "Ask");
});
