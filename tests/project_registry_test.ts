import assert from "node:assert/strict";
import { relative } from "node:path";
import type { CodexSession, NativeTurnEvent } from "../src/codex_client.ts";
import { VantageError } from "../src/errors.ts";
import type { SessionEvent } from "../src/events.ts";
import { PersistenceOwner } from "../src/persistence.ts";
import {
  inspectRegisteredRepository,
  ProjectRegistryController,
} from "../src/project_registry.ts";
import { SessionController } from "../src/session_controller.ts";

let nativeTurnSequence = 0;

class FakeCodex implements CodexSession {
  readonly prompts: string[] = [];
  readonly initializeRequests: Array<string | null> = [];
  threadStarts = 0;
  shutdowns = 0;
  onTurnEvent: ((event: NativeTurnEvent) => void) | null = null;
  initializeGate: Promise<void> = Promise.resolve();

  constructor(readonly repository: string, readonly log: string[]) {}

  async initialize(request?: { nativeThreadId?: string }) {
    this.initializeRequests.push(request?.nativeThreadId ?? null);
    this.log.push(`initialize:${this.repository}`);
    await this.initializeGate;
    return {
      threadId: request?.nativeThreadId ?? null,
      resumed: request?.nativeThreadId !== undefined,
    };
  }

  startDurableThread(): Promise<string> {
    this.threadStarts++;
    this.log.push(`start-thread:${this.repository}`);
    return Promise.resolve(`thread:${this.repository}`);
  }

  startTurn(
    prompt: string,
    onEvent: (event: NativeTurnEvent) => void,
  ): Promise<string> {
    this.prompts.push(prompt);
    this.onTurnEvent = onEvent;
    return Promise.resolve(`turn-${++nativeTurnSequence}`);
  }

  interruptTurn(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.shutdowns++;
    this.log.push(`shutdown:${this.repository}`);
    return Promise.resolve();
  }
}

interface RegistryHarness {
  readonly persistence: PersistenceOwner;
  readonly session: SessionController;
  readonly registry: ProjectRegistryController;
  readonly clients: FakeCodex[];
  readonly log: string[];
  readonly events: SessionEvent[];
}

async function createHarness(
  databasePath: string,
  ids: string[],
): Promise<RegistryHarness> {
  const persistence = await PersistenceOwner.open(databasePath);
  const clients: FakeCodex[] = [];
  const log: string[] = [];
  const events: SessionEvent[] = [];
  const session = new SessionController(
    (event) => {
      events.push(event);
    },
    (repository) => {
      const client = new FakeCodex(repository, log);
      clients.push(client);
      return client;
    },
  );
  const registry = new ProjectRegistryController(
    persistence,
    session,
    undefined,
    undefined,
    () => {
      const id = ids.shift();
      if (!id) throw new Error("test ID supply exhausted");
      return id;
    },
    (() => {
      let timestamp = 100;
      return () => timestamp++;
    })(),
  );
  await registry.initialize();
  return { persistence, session, registry, clients, log, events };
}

async function makeGitRepository(
  parent: string,
  name: string,
): Promise<string> {
  const root = `${parent}/${name}`;
  await Deno.mkdir(root);
  const result = await new Deno.Command("git", {
    args: ["init", "--quiet", root],
  }).output();
  assert.equal(result.success, true);
  return await Deno.realPath(root);
}

async function gitStatus(root: string): Promise<string> {
  const result = await new Deno.Command("git", {
    args: ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.equal(result.success, true);
  return new TextDecoder().decode(result.stdout);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for the deferred registry operation.");
}

Deno.test("registry canonicalizes aliases, persists order and selection, and starts only the selected project", async () => {
  const directory = await Deno.makeTempDir({ prefix: "vantage-registry-" });
  const databasePath = `${directory}/vantage.sqlite3`;
  const first = await makeGitRepository(directory, "first");
  const second = await makeGitRepository(directory, "second");
  const nested = `${first}/nested`;
  const alias = `${directory}/first-alias`;
  await Deno.mkdir(nested);
  await Deno.symlink(first, alias);

  let harness = await createHarness(databasePath, [
    "project-first",
    "conversation-first",
    "project-second",
    "conversation-second",
  ]);
  try {
    let snapshot = await harness.registry.addProject(nested);
    assert.equal(snapshot.projects[0].canonicalRoot, first);
    assert.equal(snapshot.selectedProjectId, "project-first");
    assert.deepEqual(harness.log, [`initialize:${first}`]);

    for (
      const duplicate of [
        first,
        nested,
        alias,
        relative(Deno.cwd(), first),
      ]
    ) {
      await assert.rejects(
        () => harness.registry.addProject(duplicate),
        (error) =>
          error instanceof VantageError &&
          error.code === "project_duplicate" &&
          error.action.includes(first),
      );
    }
    assert.equal(harness.clients.length, 1);

    snapshot = await harness.registry.addProject(second);
    assert.deepEqual(
      snapshot.projects.map((project) => project.canonicalRoot),
      [first, second],
    );
    assert.equal(snapshot.selectedProjectId, "project-second");
    assert.deepEqual(harness.log, [
      `initialize:${first}`,
      `shutdown:${first}`,
      `initialize:${second}`,
    ]);

    snapshot = await harness.registry.selectProject("project-first");
    assert.equal(snapshot.selectedProjectId, "project-first");
    assert.deepEqual(harness.log.slice(-2), [
      `shutdown:${second}`,
      `initialize:${first}`,
    ]);
    await harness.registry.close();

    harness = await createHarness(databasePath, []);
    snapshot = harness.registry.snapshot();
    assert.deepEqual(
      snapshot.projects.map((project) => project.id),
      ["project-first", "project-second"],
    );
    assert.equal(snapshot.selectedProjectId, "project-first");
    assert.equal(harness.clients.length, 0);
    await harness.registry.activateSelectedProject();
    assert.deepEqual(harness.log, [`initialize:${first}`]);
  } finally {
    await harness.registry.close().catch(() => undefined);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("unavailable registrations remain visible at their exact identity across relaunch", async () => {
  const directory = await Deno.makeTempDir({ prefix: "vantage-unavailable-" });
  const databasePath = `${directory}/vantage.sqlite3`;
  const root = await makeGitRepository(directory, "saved");
  const moved = `${directory}/moved`;
  let harness = await createHarness(databasePath, [
    "project-saved",
    "conversation-saved",
  ]);
  try {
    await harness.registry.addProject(root);
    const selectedClient = harness.clients[0];
    await harness.persistence.setNativeThread({
      projectId: "project-saved",
      conversationId: "conversation-saved",
      nativeThreadId: "saved-native-id",
    });
    await harness.persistence.beginTurn({
      projectId: "project-saved",
      conversationId: "conversation-saved",
      turnId: "completed-rich-turn",
      ordinal: 0,
      prompt: "literal **saved prompt**",
      createdAt: 110,
    });
    await harness.persistence.markTurnAccepted({
      projectId: "project-saved",
      conversationId: "conversation-saved",
      turnId: "completed-rich-turn",
      nativeTurnId: "native-turn",
      acceptedAt: 111,
    });
    await harness.persistence.appendAssistantDelta({
      projectId: "project-saved",
      conversationId: "conversation-saved",
      turnId: "completed-rich-turn",
      sequence: 0,
      delta: "```mermaid\ngraph LR\n  Saved --> Restored\n```\n",
    });
    await harness.persistence.appendAssistantDelta({
      projectId: "project-saved",
      conversationId: "conversation-saved",
      turnId: "completed-rich-turn",
      sequence: 1,
      delta:
        '```svg\n<svg viewBox="0 0 1 1"></svg>\n```\n<script>inert</script>',
    });
    await harness.persistence.finishTurn({
      projectId: "project-saved",
      conversationId: "conversation-saved",
      turnId: "completed-rich-turn",
      status: "completed",
      terminalAt: 112,
    });
    await Deno.rename(root, moved);
    let snapshot = await harness.registry.refreshProjects();
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.projects[0].canonicalRoot, root);
    assert.equal(snapshot.projects[0].availability, "missing");
    assert.match(
      snapshot.projects[0].unavailableAction ?? "",
      /exact saved path/i,
    );
    assert.equal(selectedClient.shutdowns, 1);
    assert.equal(harness.session.snapshot().repository, null);
    assert.equal(snapshot.conversation?.nativeThreadId, "saved-native-id");
    assert.equal(snapshot.conversation?.nativeResumeState, "resumable");
    assert.equal(snapshot.conversation?.nativeResumeFailure, null);
    assert.equal(
      snapshot.conversation?.turns[0].prompt,
      "literal **saved prompt**",
    );
    assert.match(
      snapshot.conversation?.turns[0].assistantSource ?? "",
      /Saved --> Restored/,
    );
    assert.equal(snapshot.conversation?.turns[0].terminalLabel, "Completed");
    await harness.registry.close();

    harness = await createHarness(databasePath, []);
    snapshot = harness.registry.snapshot();
    assert.equal(snapshot.projects[0].canonicalRoot, root);
    assert.equal(snapshot.projects[0].availability, "missing");
    assert.equal(snapshot.selectedProjectId, "project-saved");
    assert.equal(snapshot.conversation?.nativeThreadId, "saved-native-id");
    assert.equal(snapshot.conversation?.nativeResumeState, "resumable");
    assert.equal(snapshot.conversation?.turns[0].terminalLabel, "Completed");
    await harness.registry.activateSelectedProject();
    assert.equal(harness.clients.length, 0);

    await Deno.symlink(moved, root);
    snapshot = await harness.registry.refreshProjects();
    assert.equal(snapshot.projects[0].availability, "identity_changed");
    assert.equal(snapshot.projects[0].canonicalRoot, root);
    assert.equal(snapshot.conversation?.nativeThreadId, "saved-native-id");
    assert.equal(harness.clients.length, 0);

    await Deno.remove(root);
    await Deno.rename(moved, root);
    snapshot = await harness.registry.refreshProjects();
    assert.equal(snapshot.projects[0].availability, "available");
    assert.equal(snapshot.conversation?.nativeThreadId, "saved-native-id");
    assert.equal(snapshot.conversation?.turns[0].terminalLabel, "Completed");
    assert.equal(harness.clients.length, 0);

    snapshot = await harness.registry.activateSelectedProject();
    assert.equal(harness.clients.length, 1);
    assert.deepEqual(harness.clients[0].initializeRequests, [
      "saved-native-id",
    ]);
    assert.equal(harness.clients[0].threadStarts, 0);
    assert.equal(snapshot.conversation?.nativeThreadId, "saved-native-id");
    assert.equal(snapshot.conversation?.nativeResumeState, "resumable");
    assert.equal(snapshot.conversation?.nativeResumeFailure, null);
    assert.equal(snapshot.conversation?.readOnly, false);
    assert.equal(snapshot.conversation?.composerAvailable, true);
    assert.equal(
      snapshot.conversation?.turns[0].prompt,
      "literal **saved prompt**",
    );
    assert.match(
      snapshot.conversation?.turns[0].assistantSource ?? "",
      /<script>inert<\/script>/,
    );
  } finally {
    await harness.registry.close().catch(() => undefined);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("removal requires confirmation, reaps only the selected process, and never changes either repository", async () => {
  const directory = await Deno.makeTempDir({ prefix: "vantage-removal-" });
  const databasePath = `${directory}/vantage.sqlite3`;
  const first = await makeGitRepository(directory, "first");
  const second = await makeGitRepository(directory, "second");
  const firstSentinel = new TextEncoder().encode("first sentinel\n");
  const secondSentinel = new TextEncoder().encode("second sentinel\n");
  await Deno.writeFile(`${first}/sentinel.txt`, firstSentinel);
  await Deno.writeFile(`${second}/sentinel.txt`, secondSentinel);
  const firstStatus = await gitStatus(first);
  const secondStatus = await gitStatus(second);
  const harness = await createHarness(databasePath, [
    "project-first",
    "conversation-first",
    "project-second",
    "conversation-second",
    "project-readded",
    "conversation-readded",
  ]);
  try {
    await harness.registry.addProject(first);
    await harness.persistence.setNativeThread({
      projectId: "project-first",
      conversationId: "conversation-first",
      nativeThreadId: "native-history-remains-codex-owned",
    });
    await harness.registry.addProject(second);
    const activeSecond = harness.clients.at(-1)!;
    await harness.session.submitPrompt("selected project stays active");
    assert.equal(harness.session.snapshot().phase, "running");

    await assert.rejects(
      () => harness.registry.removeProject("project-first", false),
      (error) =>
        error instanceof VantageError &&
        error.code === "removal_confirmation",
    );
    assert.equal(harness.registry.snapshot().projects.length, 2);

    await harness.registry.removeProject("project-first", true);
    assert.equal(activeSecond.shutdowns, 0);
    assert.equal(harness.session.snapshot().phase, "running");
    activeSecond.onTurnEvent?.({
      type: "delta",
      delta: "selected response continues",
    });
    activeSecond.onTurnEvent?.({
      type: "terminal",
      status: "completed",
      canContinue: true,
    });
    await waitFor(() => harness.session.snapshot().phase === "completed");
    assert.deepEqual(
      harness.events.slice(-2),
      [
        {
          type: "assistant_delta",
          delta: "selected response continues",
        },
        {
          type: "turn_terminal",
          status: "completed",
          message: undefined,
          action: undefined,
          canContinue: true,
        },
      ],
    );
    assert.equal(harness.session.snapshot().phase, "completed");
    assert.deepEqual(
      await Deno.readFile(`${first}/sentinel.txt`),
      firstSentinel,
    );
    assert.deepEqual(
      await Deno.readFile(`${second}/sentinel.txt`),
      secondSentinel,
    );
    assert.equal(await gitStatus(first), firstStatus);
    assert.equal(await gitStatus(second), secondStatus);
    await assert.rejects(
      () => harness.registry.removeProject("project-first", true),
      (error) =>
        error instanceof VantageError && error.code === "project_missing",
    );

    await harness.registry.removeProject("project-second", true);
    assert.equal(activeSecond.shutdowns, 1);
    assert.deepEqual(harness.registry.snapshot(), {
      projects: [],
      selectedProjectId: null,
      conversation: null,
    });
    assert.deepEqual(
      await Deno.readFile(`${first}/sentinel.txt`),
      firstSentinel,
    );
    assert.deepEqual(
      await Deno.readFile(`${second}/sentinel.txt`),
      secondSentinel,
    );
    assert.equal(await gitStatus(first), firstStatus);
    assert.equal(await gitStatus(second), secondStatus);

    await harness.registry.addProject(first);
    const stored = await harness.persistence.readProjectRegistry();
    assert.equal(stored.projects[0].project.id, "project-readded");
    assert.equal(
      stored.projects[0].conversation.id,
      "conversation-readded",
    );
    assert.equal(stored.projects[0].conversation.nativeThreadId, null);
    assert.equal(
      stored.projects[0].conversation.nativeResumeState,
      "unstarted",
    );
  } finally {
    await harness.registry.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("no-longer-Git roots are actionable and selection is blocked during an active turn", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "vantage-registry-state-",
  });
  const databasePath = `${directory}/vantage.sqlite3`;
  const first = await makeGitRepository(directory, "first");
  const second = await makeGitRepository(directory, "second");
  const harness = await createHarness(databasePath, [
    "project-first",
    "conversation-first",
    "project-second",
    "conversation-second",
  ]);
  try {
    await harness.registry.addProject(first);
    await harness.registry.addProject(second);
    await harness.session.submitPrompt("active");
    await assert.rejects(
      () => harness.registry.selectProject("project-first"),
      /still working in the current project/,
    );
    assert.equal(
      harness.registry.snapshot().selectedProjectId,
      "project-second",
    );
    assert.equal(harness.clients.at(-1)?.shutdowns, 0);

    harness.clients.at(-1)?.onTurnEvent?.({
      type: "terminal",
      status: "completed",
      canContinue: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Deno.rename(`${first}/.git`, `${first}/git-metadata-away`);
    const availability = await inspectRegisteredRepository(first);
    assert.equal(availability.availability, "not_git");
    assert.match(availability.action ?? "", /restore its Git metadata/i);

    await harness.session.submitPrompt("remove this selected project");
    const selectedClient = harness.clients.at(-1)!;
    const snapshot = await harness.registry.removeProject(
      "project-second",
      true,
    );
    assert.equal(selectedClient.shutdowns, 1);
    assert.equal(snapshot.selectedProjectId, "project-first");
    assert.equal(snapshot.projects[0].availability, "not_git");
    assert.equal(harness.session.snapshot().phase, "empty");
  } finally {
    await harness.registry.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("refresh reaps an unavailable selected project while its session is still starting", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "vantage-refresh-starting-",
  });
  const databasePath = `${directory}/vantage.sqlite3`;
  const root = await makeGitRepository(directory, "selected");
  const moved = `${directory}/moved`;
  const persistence = await PersistenceOwner.open(databasePath);
  const initialization = Promise.withResolvers<void>();
  const log: string[] = [];
  const client = new FakeCodex(root, log);
  client.initializeGate = initialization.promise;
  const events: string[] = [];
  const session = new SessionController(
    (event) => {
      events.push(event.type);
    },
    () => client,
    (path) => Promise.resolve(String(path)),
  );
  const registry = new ProjectRegistryController(persistence, session);

  try {
    await persistence.createProjectWithConversation({
      projectId: "project-selected",
      conversationId: "conversation-selected",
      canonicalRoot: root,
      createdAt: 1,
    });
    await persistence.setSelectedProject("project-selected", 2);
    await registry.initialize();

    const starting = session.startSession(root, root);
    await waitFor(() => log.includes(`initialize:${root}`));
    assert.deepEqual(session.snapshot(), {
      phase: "starting",
      repository: null,
    });

    await Deno.rename(root, moved);
    const snapshot = await registry.refreshProjects();
    assert.equal(snapshot.projects[0].availability, "missing");
    assert.equal(client.shutdowns, 1);
    assert.deepEqual(session.snapshot(), {
      phase: "empty",
      repository: null,
    });

    initialization.reject(new Error("late initialization rejection"));
    await starting;
    assert.deepEqual(events, []);
    assert.equal(client.shutdowns, 1);
    assert.deepEqual(session.snapshot(), {
      phase: "empty",
      repository: null,
    });
  } finally {
    await registry.close().catch(() => undefined);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the native registry boundary rejects a competing mutation while validation is deferred", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "vantage-registry-busy-",
  });
  const databasePath = `${directory}/vantage.sqlite3`;
  const root = await makeGitRepository(directory, "project");
  const persistence = await PersistenceOwner.open(databasePath);
  const validation = Promise.withResolvers<string>();
  let validationStarted = false;
  const session = new SessionController(
    () => {},
    (repository) => new FakeCodex(repository, []),
  );
  const ids = ["project-busy", "conversation-busy"];
  const registry = new ProjectRegistryController(
    persistence,
    session,
    () => {
      validationStarted = true;
      return validation.promise;
    },
    undefined,
    () => ids.shift()!,
    () => 10,
  );

  try {
    await registry.initialize();
    const adding = registry.addProject(root);
    await waitFor(() => validationStarted);
    await assert.rejects(
      () => registry.refreshProjects(),
      (error) =>
        error instanceof VantageError &&
        error.code === "invalid_command" &&
        /already in progress/i.test(error.message),
    );

    validation.resolve(root);
    const snapshot = await adding;
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.selectedProjectId, "project-busy");
    assert.deepEqual(session.snapshot(), {
      phase: "ready",
      repository: root,
    });
  } finally {
    validation.resolve(root);
    await registry.close().catch(() => undefined);
    await Deno.remove(directory, { recursive: true });
  }
});
