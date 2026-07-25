import assert from "node:assert/strict";
import type { CodexSession, NativeTurnEvent } from "../src/codex_client.ts";
import { VantageError } from "../src/errors.ts";
import type { SessionEvent } from "../src/events.ts";
import { SessionController } from "../src/session_controller.ts";

class FakeCodex implements CodexSession {
  initialized = 0;
  shutdowns = 0;
  interrupts = 0;
  prompts: string[] = [];
  onTurnEvent: ((event: NativeTurnEvent) => void) | null = null;
  startGate: Promise<void> = Promise.resolve();
  initializeError: unknown = null;

  initialize(): Promise<void> {
    this.initialized++;
    if (this.initializeError) return Promise.reject(this.initializeError);
    return Promise.resolve();
  }

  async startTurn(
    prompt: string,
    onEvent: (event: NativeTurnEvent) => void,
  ): Promise<void> {
    this.prompts.push(prompt);
    this.onTurnEvent = onEvent;
    await this.startGate;
  }

  interruptTurn(): Promise<void> {
    this.interrupts++;
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.shutdowns++;
    return Promise.resolve();
  }

  emit(event: NativeTurnEvent): void {
    this.onTurnEvent?.(event);
  }
}

function flushEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(fake = new FakeCodex()) {
  const events: SessionEvent[] = [];
  let factoryCalls = 0;
  const controller = new SessionController(
    (event) => {
      events.push(event);
    },
    () => {
      factoryCalls++;
      return fake;
    },
    (path) => {
      if (path !== "/repo") {
        return Promise.reject(
          new VantageError(
            "repository",
            "Invalid repository.",
            "Correct the path and retry.",
          ),
        );
      }
      return Promise.resolve("/repo");
    },
  );
  return { controller, events, fake, factoryCalls: () => factoryCalls };
}

Deno.test("invalid repositories launch no Codex process and remain retryable", async () => {
  const h = harness();
  const result = await h.controller.startSession("/wrong");
  assert.equal(result.phase, "failed");
  assert.equal(h.factoryCalls(), 0);
  assert.deepEqual(h.events, [{
    type: "session_failed",
    code: "repository",
    message: "Invalid repository.",
    action: "Correct the path and retry.",
  }]);

  assert.equal((await h.controller.startSession("/repo")).phase, "ready");
  assert.equal(h.factoryCalls(), 1);
});

Deno.test("only one prompt is accepted while native acceptance is pending", async () => {
  const h = harness();
  const gate = Promise.withResolvers<void>();
  h.fake.startGate = gate.promise;
  await h.controller.startSession("/repo");

  const first = h.controller.submitPrompt("First question");
  await Promise.resolve();
  await assert.rejects(
    () => h.controller.submitPrompt("Duplicate question"),
    /cannot accept a prompt right now/,
  );
  assert.deepEqual(h.fake.prompts, ["First question"]);
  gate.resolve();
  await first;
});

Deno.test("assistant deltas stay ordered through a truthful terminal state", async () => {
  const h = harness();
  await h.controller.startSession("/repo");
  await h.controller.submitPrompt("Inspect the repository");
  h.fake.emit({ type: "accepted" });
  h.fake.emit({ type: "delta", delta: "one " });
  h.fake.emit({ type: "delta", delta: "two" });
  h.fake.emit({
    type: "terminal",
    status: "completed",
    canContinue: true,
  });
  await flushEvents();

  assert.deepEqual(
    h.events.map((event) => event.type),
    [
      "repository_ready",
      "turn_pending",
      "turn_accepted",
      "assistant_delta",
      "assistant_delta",
      "turn_terminal",
    ],
  );
  assert.equal(
    h.events[3].type === "assistant_delta" && h.events[3].delta,
    "one ",
  );
  assert.equal(
    h.events[4].type === "assistant_delta" && h.events[4].delta,
    "two",
  );
  assert.equal(h.controller.snapshot().phase, "completed");
});

Deno.test("sequential prompts reuse one native session and preserve event order", async () => {
  const h = harness();
  await h.controller.startSession("/repo");

  await h.controller.submitPrompt("Remember the word amber");
  h.fake.emit({ type: "accepted" });
  h.fake.emit({ type: "delta", delta: "Remembered." });
  h.fake.emit({
    type: "terminal",
    status: "completed",
    canContinue: true,
  });
  await flushEvents();

  await h.controller.submitPrompt("Which word?");
  h.fake.emit({ type: "accepted" });
  h.fake.emit({ type: "delta", delta: "amber" });
  h.fake.emit({
    type: "terminal",
    status: "completed",
    canContinue: true,
  });
  await flushEvents();

  assert.equal(h.factoryCalls(), 1);
  assert.deepEqual(h.fake.prompts, [
    "Remember the word amber",
    "Which word?",
  ]);
  assert.deepEqual(
    h.events.map((event) => event.type),
    [
      "repository_ready",
      "turn_pending",
      "turn_accepted",
      "assistant_delta",
      "turn_terminal",
      "turn_pending",
      "turn_accepted",
      "assistant_delta",
      "turn_terminal",
    ],
  );
});

Deno.test("stop stays pending until interruption and then permits a follow-up", async () => {
  const h = harness();
  await h.controller.startSession("/repo");
  await h.controller.submitPrompt("Give a long answer");
  h.fake.emit({ type: "accepted" });
  await flushEvents();

  const stopped = await h.controller.stopTurn();
  assert.equal(stopped.phase, "interrupting");
  assert.equal(h.fake.interrupts, 1);
  assert.equal(h.events.at(-1)?.type, "turn_interrupting");
  assert.equal(
    h.events.some((event) => event.type === "turn_terminal"),
    false,
  );
  await assert.rejects(
    () => h.controller.submitPrompt("Too early"),
    /cannot accept a prompt right now/,
  );

  h.fake.emit({
    type: "terminal",
    status: "interrupted",
    canContinue: true,
  });
  await flushEvents();
  assert.equal(h.controller.snapshot().phase, "interrupted");
  assert.equal(h.events.at(-1)?.type, "turn_terminal");

  await h.controller.submitPrompt("Continue with a short answer");
  assert.deepEqual(h.fake.prompts, [
    "Give a long answer",
    "Continue with a short answer",
  ]);
});

Deno.test("a retryable native turn failure restores prompt usability", async () => {
  const h = harness();
  await h.controller.startSession("/repo");
  await h.controller.submitPrompt("First attempt");
  h.fake.emit({
    type: "terminal",
    status: "failed",
    message: "Temporary model failure.",
    canContinue: true,
  });
  await flushEvents();

  assert.equal(h.controller.snapshot().phase, "turn_failed");
  await h.controller.submitPrompt("Different follow-up");
  assert.deepEqual(h.fake.prompts, ["First attempt", "Different follow-up"]);
});

Deno.test("authentication failures are actionable, retryable, and clean up", async () => {
  const first = new FakeCodex();
  first.initializeError = new VantageError(
    "authentication",
    "Codex is not authenticated.",
    "Run `codex login` outside Vantage, then retry.",
  );
  const second = new FakeCodex();
  const events: SessionEvent[] = [];
  const clients = [first, second];
  const controller = new SessionController(
    (event) => {
      events.push(event);
    },
    () => clients.shift()!,
    () => Promise.resolve("/repo"),
  );

  assert.equal((await controller.startSession("/repo")).phase, "failed");
  assert.equal(first.shutdowns, 1);
  assert.equal(events[0].type, "session_failed");
  assert.equal(
    events[0].type === "session_failed" && events[0].code,
    "authentication",
  );
  assert.equal((await controller.startSession("/repo")).phase, "ready");
});

Deno.test("closing an idle or active session reaps the owned process", async () => {
  const idle = harness();
  await idle.controller.startSession("/repo");
  await idle.controller.close();
  assert.equal(idle.fake.shutdowns, 1);
  assert.equal(idle.controller.snapshot().phase, "closed");

  const active = harness();
  const gate = Promise.withResolvers<void>();
  active.fake.startGate = gate.promise;
  await active.controller.startSession("/repo");
  const pending = active.controller.submitPrompt("Long question");
  await Promise.resolve();
  await active.controller.close();
  assert.equal(active.fake.shutdowns, 1);
  assert.equal(active.controller.snapshot().phase, "closed");
  gate.resolve();
  await pending;
});
