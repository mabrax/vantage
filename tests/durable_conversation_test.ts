import assert from "node:assert/strict";
import type {
  CodexSession,
  NativeSessionRequest,
  NativeTurnEvent,
} from "../src/codex_client.ts";
import { VantageError } from "../src/errors.ts";
import type { SessionEvent } from "../src/events.ts";
import { PersistenceOwner, StorageError } from "../src/persistence.ts";
import {
  type AvailabilityResult,
  ProjectRegistryController,
} from "../src/project_registry.ts";
import {
  type DurableSessionScope,
  SessionController,
  type SessionPersistence,
} from "../src/session_controller.ts";

const AVAILABLE: AvailabilityResult = {
  availability: "available",
  message: null,
  action: null,
};

let nativeTurnSequence = 0;

class DurableFakeCodex implements CodexSession {
  readonly initializeRequests: (string | null)[] = [];
  readonly prompts: string[] = [];
  readonly log: string[];
  onEvent: ((event: NativeTurnEvent) => void) | null = null;
  startGate: Promise<void> = Promise.resolve();
  threadId: string;
  initializeError: unknown = null;
  interruptTerminal = false;
  threadStarts = 0;

  constructor(
    readonly repository: string,
    log: string[] = [],
    threadId = `native:${repository}`,
  ) {
    this.log = log;
    this.threadId = threadId;
  }

  initialize(request?: NativeSessionRequest) {
    this.initializeRequests.push(request?.nativeThreadId ?? null);
    this.log.push(`initialize:${this.repository}`);
    if (this.initializeError) return Promise.reject(this.initializeError);
    return Promise.resolve({
      threadId: request?.nativeThreadId ?? null,
      resumed: request?.nativeThreadId !== undefined,
    });
  }

  startDurableThread(): Promise<string> {
    this.threadStarts++;
    this.log.push(`start-thread:${this.repository}`);
    return Promise.resolve(this.threadId);
  }

  async startTurn(
    prompt: string,
    onEvent: (event: NativeTurnEvent) => void,
  ): Promise<string> {
    this.prompts.push(prompt);
    this.onEvent = onEvent;
    this.log.push(`dispatch:${this.repository}`);
    await this.startGate;
    return `turn-${++nativeTurnSequence}`;
  }

  interruptTurn(): Promise<void> {
    this.log.push(`interrupt:${this.repository}`);
    if (this.interruptTerminal) {
      queueMicrotask(() =>
        this.emit({
          type: "terminal",
          status: "interrupted",
          canContinue: true,
          nativeTruth: true,
        })
      );
    }
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.log.push(`shutdown:${this.repository}`);
    return Promise.resolve();
  }

  emit(event: NativeTurnEvent): void {
    this.onEvent?.(event);
  }
}

type FailurePoint =
  | "mapping"
  | "begin"
  | "accept"
  | "append"
  | "finish"
  | "reconcile";

class FaultingPersistence implements SessionPersistence {
  constructor(
    readonly owner: PersistenceOwner,
    readonly failurePoint: FailurePoint,
  ) {}

  #fail(point: FailurePoint): void {
    if (this.failurePoint === point) {
      throw new StorageError(
        "storage_write",
        `Injected ${point} failure.`,
        "Preserve the database and do not replay the prompt.",
      );
    }
  }

  setNativeThread(
    input: Parameters<PersistenceOwner["setNativeThread"]>[0],
  ): Promise<void> {
    this.#fail("mapping");
    return this.owner.setNativeThread(input);
  }

  beginTurn(
    input: Parameters<PersistenceOwner["beginTurn"]>[0],
  ): Promise<void> {
    this.#fail("begin");
    return this.owner.beginTurn(input);
  }

  markTurnAccepted(
    input: Parameters<PersistenceOwner["markTurnAccepted"]>[0],
  ): Promise<void> {
    this.#fail("accept");
    return this.owner.markTurnAccepted(input);
  }

  appendAssistantDelta(
    input: Parameters<PersistenceOwner["appendAssistantDelta"]>[0],
  ): Promise<void> {
    this.#fail("append");
    return this.owner.appendAssistantDelta(input);
  }

  finishTurn(
    input: Parameters<PersistenceOwner["finishTurn"]>[0],
  ): Promise<void> {
    this.#fail("finish");
    return this.owner.finishTurn(input);
  }

  reconcileAfterSessionLoss(
    input: Parameters<PersistenceOwner["reconcileAfterSessionLoss"]>[0],
  ) {
    this.#fail("reconcile");
    return this.owner.reconcileAfterSessionLoss(input);
  }

  markNativeNonResumable(
    input: Parameters<PersistenceOwner["markNativeNonResumable"]>[0],
  ): Promise<void> {
    return this.owner.markNativeNonResumable(input);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for durable conversation state.");
}

function scope(
  projectId: string,
  conversationId: string,
  nativeThreadId: string | null = null,
  nextOrdinal = 0,
): DurableSessionScope {
  return {
    projectId,
    conversationId,
    nativeThreadId,
    nativeResumeState: nativeThreadId ? "resumable" : "unstarted",
    nextOrdinal,
    readOnly: false,
  };
}

Deno.test("fresh add and re-add stay unstarted until the first literal prompt maps one durable thread", async () => {
  const directory = await Deno.makeTempDir({ prefix: "vantage-durable-add-" });
  const persistence = await PersistenceOwner.open(
    `${directory}/vantage.sqlite3`,
  );
  const clients: DurableFakeCodex[] = [];
  const session = new SessionController(
    () => {},
    (repository) => {
      const client = new DurableFakeCodex(repository);
      clients.push(client);
      return client;
    },
    (value) => Promise.resolve(String(value)),
  );
  const ids = [
    "project-first",
    "conversation-first",
    "project-readded",
    "conversation-readded",
  ];
  const registry = new ProjectRegistryController(
    persistence,
    session,
    (value) => Promise.resolve(String(value)),
    () => Promise.resolve(AVAILABLE),
    () => ids.shift()!,
    () => 10,
  );

  try {
    let view = await registry.initialize();
    assert.equal(view.conversation, null);
    view = await registry.addProject("/repo");
    assert.equal(view.conversation?.nativeResumeState, "unstarted");
    assert.equal(view.conversation?.nativeThreadId, null);
    assert.deepEqual(view.conversation?.turns, []);
    assert.equal(clients[0].threadStarts, 0);
    assert.deepEqual(clients[0].initializeRequests, [null]);

    await registry.removeProject("project-first", true);
    view = await registry.addProject("/repo");
    assert.equal(view.conversation?.conversationId, "conversation-readded");
    assert.equal(view.conversation?.nativeResumeState, "unstarted");
    assert.equal(view.conversation?.nativeThreadId, null);
    assert.deepEqual(view.conversation?.turns, []);
    assert.equal(clients.at(-1)?.threadStarts, 0);
  } finally {
    await registry.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("first submit persists mapping then pending literal source before native dispatch and maps only once", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "vantage-first-submit-",
  });
  const persistence = await PersistenceOwner.open(
    `${directory}/vantage.sqlite3`,
  );
  await persistence.createProjectWithConversation({
    projectId: "project",
    conversationId: "conversation",
    canonicalRoot: "/repo",
    createdAt: 1,
  });
  const events: SessionEvent[] = [];
  const client = new DurableFakeCodex("/repo");
  const originalStartTurn = client.startTurn.bind(client);
  client.startTurn = async (prompt, onEvent) => {
    if (prompt === "  literal prompt\n") {
      const saved = await persistence.readConversation({
        projectId: "project",
        conversationId: "conversation",
      });
      assert.equal(saved?.conversation.nativeThreadId, "native:/repo");
      assert.equal(saved?.conversation.nativeResumeState, "resumable");
      assert.equal(saved?.turns.length, 1);
      assert.equal(saved?.turns[0].prompt, "  literal prompt\n");
      assert.equal(saved?.turns[0].phase, "pending");
    }
    return await originalStartTurn(prompt, onEvent);
  };
  const session = new SessionController(
    (event) => {
      events.push(event);
    },
    () => client,
    (value) => Promise.resolve(String(value)),
  );
  session.attachPersistence(persistence);

  try {
    await session.startSession(
      "/repo",
      "/repo",
      scope(
        "project",
        "conversation",
      ),
    );
    await session.submitPrompt("  literal prompt\n");
    assert.equal(client.threadStarts, 1);
    assert.deepEqual(client.prompts, ["  literal prompt\n"]);
    client.emit({
      type: "terminal",
      status: "completed",
      canContinue: true,
      nativeTruth: true,
    });
    await waitFor(() => session.snapshot().phase === "completed");

    await session.submitPrompt("follow-up");
    assert.equal(client.threadStarts, 1);
    assert.deepEqual(client.prompts, ["  literal prompt\n", "follow-up"]);
    assert.equal(
      events.filter((event) => event.type === "turn_pending").length,
      2,
    );
  } finally {
    await session.close();
    await persistence.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native acceptance callback racing the turn/start response commits and projects exactly once", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "vantage-acceptance-race-",
  });
  const persistence = await PersistenceOwner.open(
    `${directory}/vantage.sqlite3`,
  );
  await persistence.createProjectWithConversation({
    projectId: "project",
    conversationId: "conversation",
    canonicalRoot: "/repo",
    createdAt: 1,
  });
  const events: SessionEvent[] = [];
  const client = new DurableFakeCodex("/repo");
  client.startTurn = async (prompt, onEvent) => {
    client.prompts.push(prompt);
    client.onEvent = onEvent;
    onEvent({
      type: "accepted",
      nativeTurnId: "racing-native-turn",
    });
    await Promise.resolve();
    return "racing-native-turn";
  };
  let acceptanceCommits = 0;
  const countingPersistence: SessionPersistence = {
    setNativeThread: (input) => persistence.setNativeThread(input),
    beginTurn: (input) => persistence.beginTurn(input),
    markTurnAccepted: (input) => {
      acceptanceCommits++;
      return persistence.markTurnAccepted(input);
    },
    appendAssistantDelta: (input) => persistence.appendAssistantDelta(input),
    finishTurn: (input) => persistence.finishTurn(input),
    reconcileAfterSessionLoss: (input) =>
      persistence.reconcileAfterSessionLoss(input),
    markNativeNonResumable: (input) =>
      persistence.markNativeNonResumable(input),
  };
  const session = new SessionController(
    (event) => {
      events.push(event);
    },
    () => client,
    (value) => Promise.resolve(String(value)),
  );
  session.attachPersistence(countingPersistence);
  try {
    await session.startSession(
      "/repo",
      "/repo",
      scope(
        "project",
        "conversation",
      ),
    );
    await session.submitPrompt("race acceptance");
    await waitFor(() => session.snapshot().phase === "running");
    assert.equal(acceptanceCommits, 1);
    assert.equal(
      events.filter((event) => event.type === "turn_accepted").length,
      1,
    );
    const saved = await persistence.readConversation({
      projectId: "project",
      conversationId: "conversation",
    });
    assert.equal(saved?.turns[0].phase, "accepted");
    assert.equal(saved?.turns[0].nativeTurnId, "racing-native-turn");
  } finally {
    await session.close();
    await persistence.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native mapping commit failure never records or dispatches the uncertain first prompt", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "vantage-map-failure-",
  });
  const persistence = await PersistenceOwner.open(
    `${directory}/vantage.sqlite3`,
  );
  await persistence.createProjectWithConversation({
    projectId: "project",
    conversationId: "conversation",
    canonicalRoot: "/repo",
    createdAt: 1,
  });
  await persistence.createProjectWithConversation({
    projectId: "other-project",
    conversationId: "other-conversation",
    canonicalRoot: "/other",
    createdAt: 2,
  });
  await persistence.setNativeThread({
    projectId: "other-project",
    conversationId: "other-conversation",
    nativeThreadId: "conflicting-native-id",
  });
  const client = new DurableFakeCodex(
    "/repo",
    [],
    "conflicting-native-id",
  );
  const session = new SessionController(
    () => {},
    () => client,
    (value) => Promise.resolve(String(value)),
  );
  session.attachPersistence(persistence);

  try {
    await session.startSession(
      "/repo",
      "/repo",
      scope(
        "project",
        "conversation",
      ),
    );
    await session.submitPrompt("must not dispatch");
    const saved = await persistence.readConversation({
      projectId: "project",
      conversationId: "conversation",
    });
    assert.equal(saved?.conversation.nativeThreadId, null);
    assert.equal(saved?.conversation.nativeResumeState, "unstarted");
    assert.deepEqual(saved?.turns, []);
    assert.deepEqual(client.prompts, []);
    assert.equal(session.snapshot().phase, "failed");
  } finally {
    await session.close();
    await persistence.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("relaunch restores exact transcript and resumes only the persisted native thread", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "vantage-relaunch-",
  });
  const databasePath = `${directory}/vantage.sqlite3`;
  let persistence = await PersistenceOwner.open(databasePath);
  await persistence.createProjectWithConversation({
    projectId: "project",
    conversationId: "conversation",
    canonicalRoot: "/repo",
    createdAt: 1,
  });
  await persistence.setSelectedProject("project", 2);
  const first = new DurableFakeCodex("/repo");
  let session = new SessionController(
    () => {},
    () => first,
    (value) => Promise.resolve(String(value)),
  );
  session.attachPersistence(persistence);
  await session.startSession(
    "/repo",
    "/repo",
    scope(
      "project",
      "conversation",
    ),
  );
  await session.submitPrompt("remember **amber**");
  first.emit({ type: "delta", delta: "saved ```svg\n<svg " });
  first.emit({
    type: "delta",
    delta: 'viewBox="0 0 1 1"></svg>\n```',
  });
  first.emit({
    type: "terminal",
    status: "completed",
    canContinue: true,
    nativeTruth: true,
  });
  await waitFor(() => session.snapshot().phase === "completed");
  const nativeThreadId = "native:/repo";
  await session.close();
  await persistence.close();

  persistence = await PersistenceOwner.open(databasePath);
  const resumed = new DurableFakeCodex("/repo");
  session = new SessionController(
    () => {},
    () => resumed,
    (value) => Promise.resolve(String(value)),
  );
  const registry = new ProjectRegistryController(
    persistence,
    session,
    (value) => Promise.resolve(String(value)),
    () => Promise.resolve(AVAILABLE),
  );
  try {
    let view = await registry.initialize();
    assert.equal(view.conversation?.turns[0].prompt, "remember **amber**");
    assert.equal(
      view.conversation?.turns[0].assistantSource,
      'saved ```svg\n<svg viewBox="0 0 1 1"></svg>\n```',
    );
    assert.equal(view.conversation?.turns[0].terminalLabel, "Completed");
    assert.equal(view.conversation?.nativeThreadId, nativeThreadId);
    view = await registry.activateSelectedProject();
    assert.deepEqual(resumed.initializeRequests, [nativeThreadId]);
    assert.equal(view.conversation?.readOnly, false);
  } finally {
    await registry.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("active switch cancel preserves source and confirm reaps before target start while late events are rejected", async () => {
  const directory = await Deno.makeTempDir({ prefix: "vantage-switch-" });
  const persistence = await PersistenceOwner.open(
    `${directory}/vantage.sqlite3`,
  );
  const log: string[] = [];
  const clients: DurableFakeCodex[] = [];
  const session = new SessionController(
    () => {},
    (repository) => {
      const client = new DurableFakeCodex(repository, log);
      clients.push(client);
      return client;
    },
    (value) => Promise.resolve(String(value)),
  );
  const ids = ["p1", "c1", "p2", "c2"];
  const registry = new ProjectRegistryController(
    persistence,
    session,
    (value) => Promise.resolve(String(value)),
    () => Promise.resolve(AVAILABLE),
    () => ids.shift()!,
    (() => {
      let now = 1;
      return () => now++;
    })(),
  );
  try {
    await registry.initialize();
    await registry.addProject("/one");
    await session.submitPrompt("first");
    clients[0].emit({
      type: "terminal",
      status: "completed",
      canContinue: true,
      nativeTruth: true,
    });
    await waitFor(() => session.snapshot().phase === "completed");
    await registry.addProject("/two");
    await session.submitPrompt("second project first");
    clients.at(-1)?.emit({
      type: "terminal",
      status: "completed",
      canContinue: true,
      nativeTruth: true,
    });
    await waitFor(() => session.snapshot().phase === "completed");
    await registry.selectProject("p1");
    const source = clients.at(-1)!;
    await session.submitPrompt("active source");

    await assert.rejects(
      () => registry.selectProject("p2"),
      (error) =>
        error instanceof VantageError &&
        error.code === "switch_confirmation",
    );
    assert.equal(registry.snapshot().selectedProjectId, "p1");
    assert.equal(log.filter((entry) => entry === "shutdown:/one").length, 1);

    source.interruptTerminal = true;
    await registry.selectProject("p2", true);
    assert.equal(registry.snapshot().selectedProjectId, "p2");
    const lastSourceShutdown = log.lastIndexOf("shutdown:/one");
    const lastTargetStart = log.lastIndexOf("initialize:/two");
    assert.ok(lastSourceShutdown >= 0);
    assert.ok(lastTargetStart > lastSourceShutdown);

    const targetSnapshot = await persistence.readConversation({
      projectId: "p2",
      conversationId: "c2",
    });
    source.emit({ type: "delta", delta: "late cross-project source" });
    source.emit({
      type: "terminal",
      status: "failed",
      canContinue: false,
      nativeTruth: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      await persistence.readConversation({
        projectId: "p2",
        conversationId: "c2",
      }),
      targetSnapshot,
    );
    const firstSaved = await persistence.readConversation({
      projectId: "p1",
      conversationId: "c1",
    });
    assert.deepEqual(
      firstSaved?.turns.map((turn) => turn.prompt),
      ["first", "active source"],
    );
    assert.deepEqual(
      targetSnapshot?.turns.map((turn) => turn.prompt),
      ["second project first"],
    );

    await registry.selectProject("p1");
    await registry.selectProject("p2");
    assert.equal(registry.snapshot().selectedProjectId, "p2");
  } finally {
    await registry.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("process loss preserves accepted truth as unresolved and failed resume remains read-only until explicit retry", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "vantage-loss-resume-",
  });
  const persistence = await PersistenceOwner.open(
    `${directory}/vantage.sqlite3`,
  );
  await persistence.createProjectWithConversation({
    projectId: "project",
    conversationId: "conversation",
    canonicalRoot: "/repo",
    createdAt: 1,
  });
  await persistence.setSelectedProject("project", 2);
  const client = new DurableFakeCodex("/repo");
  const session = new SessionController(
    () => {},
    () => client,
    (value) => Promise.resolve(String(value)),
  );
  session.attachPersistence(persistence);
  await session.startSession(
    "/repo",
    "/repo",
    scope(
      "project",
      "conversation",
    ),
  );
  await session.submitPrompt("accepted before process loss");
  client.emit({
    type: "terminal",
    status: "failed",
    canContinue: false,
    nativeTruth: false,
  });
  await waitFor(() => session.snapshot().phase === "failed");
  let saved = await persistence.readConversation({
    projectId: "project",
    conversationId: "conversation",
  });
  assert.equal(saved?.turns[0].phase, "accepted");
  assert.equal(saved?.turns[0].recoveryDisposition, "incomplete_accepted");
  assert.equal(saved?.turns[0].terminalStatus, null);
  await session.close();

  await persistence.markNativeNonResumable({
    projectId: "project",
    conversationId: "conversation",
    failure: "missing",
  });
  const retry = new DurableFakeCodex("/repo");
  retry.initializeError = new VantageError(
    "native_missing",
    "The saved native Codex conversation is missing.",
    "Retry or remove.",
  );
  const retrySession = new SessionController(
    () => {},
    () => retry,
    (value) => Promise.resolve(String(value)),
  );
  const registry = new ProjectRegistryController(
    persistence,
    retrySession,
    (value) => Promise.resolve(String(value)),
    () => Promise.resolve(AVAILABLE),
  );
  try {
    const view = await registry.initialize();
    assert.equal(view.conversation?.readOnly, true);
    assert.equal(view.conversation?.composerAvailable, false);
    assert.equal(view.conversation?.nativeResumeFailure, "missing");
    assert.equal(retry.initializeRequests.length, 0);
    saved = await persistence.readConversation({
      projectId: "project",
      conversationId: "conversation",
    });
    assert.equal(saved?.turns[0].terminalStatus, null);
  } finally {
    await registry.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("explicit retry re-attempts only the saved native ID and restores composer availability", async () => {
  const directory = await Deno.makeTempDir({ prefix: "vantage-retry-" });
  const persistence = await PersistenceOwner.open(
    `${directory}/vantage.sqlite3`,
  );
  await persistence.createProjectWithConversation({
    projectId: "project",
    conversationId: "conversation",
    canonicalRoot: "/repo",
    createdAt: 1,
  });
  await persistence.setSelectedProject("project", 2);
  await persistence.setNativeThread({
    projectId: "project",
    conversationId: "conversation",
    nativeThreadId: "saved-native-id",
  });
  await persistence.markNativeNonResumable({
    projectId: "project",
    conversationId: "conversation",
    failure: "resume_failed",
  });
  const retry = new DurableFakeCodex("/repo");
  const session = new SessionController(
    () => {},
    () => retry,
    (value) => Promise.resolve(String(value)),
  );
  const registry = new ProjectRegistryController(
    persistence,
    session,
    (value) => Promise.resolve(String(value)),
    () => Promise.resolve(AVAILABLE),
  );
  try {
    let view = await registry.initialize();
    assert.equal(view.conversation?.readOnly, true);
    assert.equal(retry.initializeRequests.length, 0);
    view = await registry.activateSelectedProject();
    assert.deepEqual(retry.initializeRequests, ["saved-native-id"]);
    assert.equal(retry.threadStarts, 0);
    assert.equal(view.conversation?.nativeResumeState, "resumable");
    assert.equal(view.conversation?.nativeResumeFailure, null);
    assert.equal(view.conversation?.readOnly, false);
    assert.equal(view.conversation?.composerAvailable, true);
  } finally {
    await registry.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("crash points preserve pending, streamed, and terminal truth without replay or false completion", async () => {
  for (
    const point of [
      "before_acceptance",
      "during_deltas",
      "after_terminal",
    ] as const
  ) {
    const directory = await Deno.makeTempDir({
      prefix: `vantage-crash-${point}-`,
    });
    const persistence = await PersistenceOwner.open(
      `${directory}/vantage.sqlite3`,
    );
    await persistence.createProjectWithConversation({
      projectId: "project",
      conversationId: "conversation",
      canonicalRoot: "/repo",
      createdAt: 1,
    });
    const client = new DurableFakeCodex("/repo");
    const session = new SessionController(
      () => {},
      () => client,
      (value) => Promise.resolve(String(value)),
    );
    session.attachPersistence(persistence);
    try {
      await session.startSession(
        "/repo",
        "/repo",
        scope(
          "project",
          "conversation",
        ),
      );
      if (point === "before_acceptance") {
        const gate = Promise.withResolvers<void>();
        client.startGate = gate.promise;
        const submitting = session.submitPrompt("literal once");
        await waitFor(() => client.prompts.length === 1);
        await session.close();
        gate.resolve();
        await submitting;
      } else {
        await session.submitPrompt("literal once");
        if (point === "during_deltas") {
          client.emit({ type: "delta", delta: "ordered partial" });
          await waitForConversationPhase(persistence, "streaming");
          await session.close();
        } else {
          client.emit({
            type: "terminal",
            status: "completed",
            canContinue: true,
            nativeTruth: true,
          });
          await waitFor(() => session.snapshot().phase === "completed");
          await session.close();
        }
      }

      const saved = await persistence.readConversation({
        projectId: "project",
        conversationId: "conversation",
      });
      assert.equal(saved?.turns.length, 1);
      assert.equal(saved?.turns[0].prompt, "literal once");
      if (point === "before_acceptance") {
        assert.equal(saved?.turns[0].phase, "pending");
        assert.equal(
          saved?.turns[0].recoveryDisposition,
          "uncertain_acceptance",
        );
        assert.equal(saved?.turns[0].terminalStatus, null);
      } else if (point === "during_deltas") {
        assert.equal(saved?.turns[0].phase, "streaming");
        assert.equal(saved?.turns[0].assistantSource, "ordered partial");
        assert.equal(
          saved?.turns[0].recoveryDisposition,
          "incomplete_stream",
        );
        assert.equal(saved?.turns[0].terminalStatus, null);
      } else {
        assert.equal(saved?.turns[0].phase, "completed");
        assert.equal(saved?.turns[0].terminalStatus, "completed");
        assert.equal(saved?.turns[0].recoveryDisposition, null);
      }
    } finally {
      await session.close().catch(() => undefined);
      await persistence.close();
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("mapping, begin, acceptance, append, and terminal storage failures block projection and reap the exact process", async () => {
  for (
    const point of [
      "mapping",
      "begin",
      "accept",
      "append",
      "finish",
    ] as const
  ) {
    const directory = await Deno.makeTempDir({
      prefix: `vantage-storage-${point}-`,
    });
    const persistence = await PersistenceOwner.open(
      `${directory}/vantage.sqlite3`,
    );
    await persistence.createProjectWithConversation({
      projectId: "project",
      conversationId: "conversation",
      canonicalRoot: "/repo",
      createdAt: 1,
    });
    const events: SessionEvent[] = [];
    const log: string[] = [];
    const client = new DurableFakeCodex("/repo", log);
    const session = new SessionController(
      (event) => {
        events.push(event);
      },
      () => client,
      (value) => Promise.resolve(String(value)),
    );
    session.attachPersistence(new FaultingPersistence(persistence, point));
    try {
      await session.startSession(
        "/repo",
        "/repo",
        scope(
          "project",
          "conversation",
        ),
      );
      await session.submitPrompt("durable boundary");
      if (point === "append") {
        client.emit({ type: "delta", delta: "must not project" });
      } else if (point === "finish") {
        client.emit({
          type: "terminal",
          status: "completed",
          canContinue: true,
          nativeTruth: true,
        });
      }
      await waitFor(() => session.snapshot().phase === "failed");
      assert.equal(log.filter((entry) => entry === "shutdown:/repo").length, 1);
      assert.equal(
        events.some((event) =>
          event.type === "turn_terminal" &&
          event.status === "completed"
        ),
        false,
      );
      assert.equal(events.at(-1)?.type, "session_failed");
      if (point === "mapping" || point === "begin") {
        assert.deepEqual(client.prompts, []);
      }
      if (point === "append") {
        assert.equal(
          events.some((event) =>
            event.type === "assistant_delta" &&
            event.delta === "must not project"
          ),
          false,
        );
      }

      const saved = await persistence.readConversation({
        projectId: "project",
        conversationId: "conversation",
      });
      if (point === "mapping") {
        assert.equal(saved?.conversation.nativeThreadId, null);
        assert.deepEqual(saved?.turns, []);
      } else if (point === "begin") {
        assert.equal(saved?.conversation.nativeThreadId, "native:/repo");
        assert.deepEqual(saved?.turns, []);
      } else if (point === "accept") {
        assert.equal(saved?.turns[0].phase, "pending");
        assert.equal(
          saved?.turns[0].recoveryDisposition,
          "uncertain_acceptance",
        );
      } else {
        assert.equal(saved?.turns[0].terminalStatus, null);
        assert.ok(saved?.turns[0].recoveryDisposition);
      }
    } finally {
      await session.close().catch(() => undefined);
      await persistence.close();
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("reconciliation failure still reaps on close and reap and cannot launch a replacement", async () => {
  for (const operation of ["close", "reap"] as const) {
    const directory = await Deno.makeTempDir({
      prefix: `vantage-reconcile-${operation}-`,
    });
    const persistence = await PersistenceOwner.open(
      `${directory}/vantage.sqlite3`,
    );
    await persistence.createProjectWithConversation({
      projectId: "project",
      conversationId: "conversation",
      canonicalRoot: "/repo",
      createdAt: 1,
    });
    const log: string[] = [];
    const clients: DurableFakeCodex[] = [];
    const session = new SessionController(
      () => {},
      (repository) => {
        const client = new DurableFakeCodex(repository, log);
        clients.push(client);
        return client;
      },
      (value) => Promise.resolve(String(value)),
    );
    session.attachPersistence(
      new FaultingPersistence(persistence, "reconcile"),
    );
    try {
      await session.startSession(
        "/repo",
        "/repo",
        scope(
          "project",
          "conversation",
        ),
      );
      await session.submitPrompt("active at cleanup");
      if (operation === "close") {
        await assert.rejects(() => session.close(), /Injected reconcile/);
      } else {
        await assert.rejects(() => session.reapSession(), /Injected reconcile/);
      }
      assert.equal(log.filter((entry) => entry === "shutdown:/repo").length, 1);
      assert.equal(clients.length, 1);
      assert.equal(
        log.some((entry) => entry === "initialize:/replacement"),
        false,
      );
    } finally {
      await session.close().catch(() => undefined);
      await persistence.close();
      await Deno.remove(directory, { recursive: true });
    }
  }
});

async function waitForConversationPhase(
  persistence: PersistenceOwner,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const saved = await persistence.readConversation({
      projectId: "project",
      conversationId: "conversation",
    });
    if (saved?.turns[0].phase === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`Timed out waiting for durable phase ${expected}.`);
}
