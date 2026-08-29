import type { HostKeyPrompt } from "../../types";

export function enqueueHostKeyPrompt(queue: HostKeyPrompt[], prompt: HostKeyPrompt) {
  return queue.some((item) => item.token === prompt.token) ? queue : [...queue, prompt];
}

export function removeHostKeyPrompt(queue: HostKeyPrompt[], token: string) {
  return queue.filter((item) => item.token !== token);
}
