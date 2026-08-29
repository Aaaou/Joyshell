import type { TerminalOutput, TerminalOutputBatch } from "../../types";

export type TerminalSequenceDecision = {
  cursor: number;
  data: string;
  initialize: boolean;
  truncated: boolean;
};

export function resolveTerminalEvent(cursor: number | undefined, output: TerminalOutput): TerminalSequenceDecision | null {
  if (cursor === undefined || output.sequence !== cursor + 1) {
    return null;
  }
  return { cursor: output.sequence, data: output.data, initialize: false, truncated: false };
}

export function resolveTerminalBatch(cursor: number | undefined, batch: TerminalOutputBatch): TerminalSequenceDecision {
  if (cursor === undefined) {
    return {
      cursor: batch.outputs.at(-1)?.sequence ?? batch.latest_sequence,
      data: batch.outputs.map((output) => output.data).join(""),
      initialize: true,
      truncated: false
    };
  }

  let nextCursor = cursor;
  let truncated = false;
  if (batch.truncated && batch.first_sequence && nextCursor + 1 < batch.first_sequence) {
    nextCursor = batch.first_sequence - 1;
    truncated = true;
  }

  let data = "";
  for (const output of batch.outputs) {
    if (output.sequence <= nextCursor) {
      continue;
    }
    if (output.sequence !== nextCursor + 1) {
      break;
    }
    nextCursor = output.sequence;
    data += output.data;
  }

  return { cursor: nextCursor, data, initialize: false, truncated };
}
