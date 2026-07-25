import { createCodexSession } from "../src/codex_client.ts";
import type { SessionEvent } from "../src/events.ts";
import { SessionController } from "../src/session_controller.ts";

const repository = Deno.args[0] ?? Deno.cwd();
const prompt = Deno.args[1] ??
  "Read README.md and reply with the exact first Markdown heading only.";
const followUp = Deno.args[2];
let answer = "";

type TerminalEvent = Extract<
  SessionEvent,
  { type: "turn_terminal" | "session_failed" }
>;
let completed = Promise.withResolvers<TerminalEvent>();
const controller = new SessionController(
  (event) => {
    if (event.type === "assistant_delta") {
      answer += event.delta;
      Deno.stdout.writeSync(new TextEncoder().encode(event.delta));
    }
    if (event.type === "turn_terminal" || event.type === "session_failed") {
      completed.resolve(event);
    }
  },
  createCodexSession,
);

try {
  const started = await controller.startSession(repository);
  if (started.phase !== "ready") {
    const terminal = await completed.promise;
    throw new Error(`Session failed: ${JSON.stringify(terminal)}`);
  }
  await controller.submitPrompt(prompt);
  let terminal = await completed.promise;
  Deno.stdout.writeSync(new TextEncoder().encode("\n"));
  if (
    terminal?.type !== "turn_terminal" ||
    terminal.status !== "completed" ||
    answer.trim().length === 0
  ) {
    throw new Error(`Turn failed: ${JSON.stringify(terminal)}`);
  }

  if (followUp) {
    answer = "";
    completed = Promise.withResolvers<TerminalEvent>();
    await controller.submitPrompt(followUp);
    terminal = await completed.promise;
    Deno.stdout.writeSync(new TextEncoder().encode("\n"));
    if (
      terminal.type !== "turn_terminal" ||
      terminal.status !== "completed" ||
      answer.trim().length === 0
    ) {
      throw new Error(`Follow-up failed: ${JSON.stringify(terminal)}`);
    }
  }
} finally {
  await controller.close();
}
