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
  initializeGate: Promise<void> = Promise.resolve();
  startGate: Promise<void> = Promise.resolve();
  interruptGate: Promise<void> = Promise.resolve();
  initializeError: unknown = null;

  async initialize(request?: { nativeThreadId?: string }) {
    this.initialized++;
    await this.initializeGate;
    if (this.initializeError) throw this.initializeError;
    return {
      threadId: request?.nativeThreadId ?? null,
      resumed: request?.nativeThreadId !== undefined,
    };
  }

  startDurableThread(): Promise<string> {
    return Promise.resolve("thread-test");
  }

  async startTurn(
    prompt: string,
    onEvent: (event: NativeTurnEvent) => void,
  ): Promise<string> {
    this.prompts.push(prompt);
    this.onTurnEvent = onEvent;
    await this.startGate;
    return `turn-${this.prompts.length}`;
  }

  async interruptTurn(): Promise<void> {
    this.interrupts++;
    await this.interruptGate;
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail("Timed out waiting for the deferred operation to start.");
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
            "Choose another repository folder and retry.",
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
    action: "Choose another repository folder and retry.",
  }]);

  assert.equal((await h.controller.startSession("/repo")).phase, "ready");
  assert.equal(h.factoryCalls(), 1);
});

Deno.test("registered project launch rejects an identity change before Codex starts", async () => {
  let factoryCalls = 0;
  const events: SessionEvent[] = [];
  const controller = new SessionController(
    (event) => {
      events.push(event);
    },
    () => {
      factoryCalls++;
      return new FakeCodex();
    },
    () => Promise.resolve("/different-canonical-root"),
  );

  const snapshot = await controller.startSession(
    "/saved-root",
    "/saved-root",
  );
  assert.equal(snapshot.phase, "failed");
  assert.equal(factoryCalls, 0);
  assert.equal(events[0].type, "session_failed");
  assert.match(
    events[0].type === "session_failed" ? events[0].message : "",
    /different Git repository/,
  );
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

  const startingFake = new FakeCodex();
  const initialization = Promise.withResolvers<void>();
  startingFake.initializeGate = initialization.promise;
  const starting = harness(startingFake);
  const pendingStart = starting.controller.startSession("/repo");
  await waitFor(() => startingFake.initialized === 1);
  await starting.controller.close();
  initialization.reject(new Error("late initialization after close"));
  await pendingStart;
  assert.equal(startingFake.shutdowns, 1);
  assert.deepEqual(starting.controller.snapshot(), {
    phase: "closed",
    repository: null,
  });
  assert.deepEqual(starting.events, []);
});

Deno.test("late native events from a replaced project cannot cross into the selected session", async () => {
  const first = new FakeCodex();
  const second = new FakeCodex();
  const clients = [first, second];
  const events: SessionEvent[] = [];
  const controller = new SessionController(
    (event) => {
      events.push(event);
    },
    () => clients.shift()!,
    (path) => Promise.resolve(String(path)),
  );

  await controller.startSession("/first");
  await controller.submitPrompt("old project prompt");
  first.emit({ type: "accepted" });
  first.emit({
    type: "terminal",
    status: "completed",
    canContinue: true,
  });
  await flushEvents();

  await controller.startSession("/second");
  const eventCount = events.length;
  first.emit({ type: "delta", delta: "late crossed source" });
  first.emit({
    type: "terminal",
    status: "failed",
    canContinue: false,
  });
  await flushEvents();

  assert.equal(events.length, eventCount);
  assert.deepEqual(controller.snapshot(), {
    phase: "ready",
    repository: "/second",
  });
  assert.equal(first.shutdowns, 1);
  assert.equal(second.shutdowns, 0);
  await controller.close();
});

Deno.test("reaping deferred initialization isolates both late resolution and rejection from the replacement", async () => {
  for (const outcome of ["resolve", "reject"] as const) {
    const oldCodex = new FakeCodex();
    const initialization = Promise.withResolvers<void>();
    oldCodex.initializeGate = initialization.promise;
    const nextCodex = new FakeCodex();
    const clients = [oldCodex, nextCodex];
    const events: SessionEvent[] = [];
    const controller = new SessionController(
      (event) => {
        events.push(event);
      },
      () => clients.shift()!,
      (path) => Promise.resolve(String(path)),
    );

    const oldStart = controller.startSession("/old");
    await waitFor(() => oldCodex.initialized === 1);
    assert.deepEqual(controller.snapshot(), {
      phase: "starting",
      repository: null,
    });

    await controller.reapSession();
    assert.equal(oldCodex.shutdowns, 1);
    await controller.startSession("/next");
    const eventCount = events.length;

    if (outcome === "resolve") initialization.resolve();
    else initialization.reject(new Error("late old initialization failure"));
    await oldStart;
    await flushEvents();

    assert.deepEqual(controller.snapshot(), {
      phase: "ready",
      repository: "/next",
    });
    assert.equal(oldCodex.shutdowns, 1);
    assert.equal(nextCodex.shutdowns, 0);
    assert.equal(events.length, eventCount);
    assert.deepEqual(
      events.map((event) =>
        event.type === "repository_ready" ? event.repository : event.type
      ),
      ["/next"],
    );
    await controller.close();
  }
});

Deno.test("a deferred old startTurn rejection and late callbacks cannot fail or dispose the replacement", async () => {
  const oldCodex = new FakeCodex();
  const turnStart = Promise.withResolvers<void>();
  oldCodex.startGate = turnStart.promise;
  const nextCodex = new FakeCodex();
  const clients = [oldCodex, nextCodex];
  const events: SessionEvent[] = [];
  const controller = new SessionController(
    (event) => {
      events.push(event);
    },
    () => clients.shift()!,
    (path) => Promise.resolve(String(path)),
  );

  await controller.startSession("/old");
  const oldSubmit = controller.submitPrompt("old prompt");
  await waitFor(() => oldCodex.prompts.length === 1);
  await controller.reapSession();
  await controller.startSession("/next");
  const eventCount = events.length;

  turnStart.reject(new Error("late old startTurn failure"));
  await oldSubmit;
  oldCodex.emit({ type: "accepted" });
  oldCodex.emit({ type: "delta", delta: "late old text" });
  oldCodex.emit({
    type: "terminal",
    status: "failed",
    canContinue: false,
  });
  await flushEvents();

  assert.deepEqual(controller.snapshot(), {
    phase: "ready",
    repository: "/next",
  });
  assert.equal(oldCodex.shutdowns, 1);
  assert.equal(nextCodex.shutdowns, 0);
  assert.equal(events.length, eventCount);
  assert.equal(
    events.slice(eventCount).some((event) =>
      event.type === "turn_terminal" || event.type === "session_failed"
    ),
    false,
  );
  await controller.close();
});

Deno.test("reaping while turn_pending is deferred prevents the stale operation from starting a turn", async () => {
  const oldCodex = new FakeCodex();
  const nextCodex = new FakeCodex();
  const clients = [oldCodex, nextCodex];
  const turnPending = Promise.withResolvers<void>();
  let pendingEventEntered = false;
  const events: SessionEvent[] = [];
  const controller = new SessionController(
    async (event) => {
      events.push(event);
      if (event.type === "turn_pending") {
        pendingEventEntered = true;
        await turnPending.promise;
      }
    },
    () => clients.shift()!,
    (path) => Promise.resolve(String(path)),
  );

  await controller.startSession("/old");
  const oldSubmit = controller.submitPrompt("old prompt");
  await waitFor(() => pendingEventEntered);
  await controller.reapSession();
  await controller.startSession("/next");
  const eventCount = events.length;

  turnPending.resolve();
  await oldSubmit;
  assert.deepEqual(oldCodex.prompts, []);
  assert.equal(events.length, eventCount);
  assert.deepEqual(controller.snapshot(), {
    phase: "ready",
    repository: "/next",
  });
  assert.equal(oldCodex.shutdowns, 1);
  assert.equal(nextCodex.shutdowns, 0);
  await controller.close();
});

Deno.test("a deferred stop failure cannot dispose or emit across a replacement", async () => {
  const oldCodex = new FakeCodex();
  const interruption = Promise.withResolvers<void>();
  oldCodex.interruptGate = interruption.promise;
  const nextCodex = new FakeCodex();
  const clients = [oldCodex, nextCodex];
  const events: SessionEvent[] = [];
  const controller = new SessionController(
    (event) => {
      events.push(event);
    },
    () => clients.shift()!,
    (path) => Promise.resolve(String(path)),
  );

  await controller.startSession("/old");
  await controller.submitPrompt("old prompt");
  const oldStop = controller.stopTurn();
  await waitFor(() => oldCodex.interrupts === 1);
  await controller.reapSession();
  await controller.startSession("/next");
  const eventCount = events.length;

  interruption.reject(new Error("late old interruption failure"));
  await oldStop;
  oldCodex.emit({
    type: "terminal",
    status: "interrupted",
    canContinue: true,
  });
  await flushEvents();

  assert.deepEqual(controller.snapshot(), {
    phase: "ready",
    repository: "/next",
  });
  assert.equal(oldCodex.shutdowns, 1);
  assert.equal(nextCodex.shutdowns, 0);
  assert.equal(events.length, eventCount);
  await controller.close();
});
