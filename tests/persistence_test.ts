import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PersistenceOwner, StorageError } from "../src/persistence.ts";
import {
  LATEST_SCHEMA_VERSION,
  type TerminalStatus,
  type TurnPhase,
} from "../src/persistence_protocol.ts";

async function withDatabase(
  run: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({
    prefix: "vantage-persistence-test-",
  });
  try {
    await run(`${directory}/vantage.sqlite3`);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

function projectInput(suffix: string, root = `/repo/${suffix}`) {
  return {
    projectId: `project-${suffix}`,
    conversationId: `conversation-${suffix}`,
    canonicalRoot: root,
    createdAt: 1,
  };
}

Deno.test("fresh storage reopens and round-trips only durable conversation truth", async () => {
  await withDatabase(async (path) => {
    let owner = await PersistenceOwner.open(path);
    const project = projectInput("roundtrip");
    await owner.createProjectWithConversation(project);
    await owner.setNativeThread({
      projectId: project.projectId,
      conversationId: project.conversationId,
      nativeThreadId: "native-thread-1",
    });
    await owner.beginTurn(
      {
        projectId: project.projectId,
        conversationId: project.conversationId,
        turnId: "turn-1",
        ordinal: 0,
        prompt: "  literal prompt\nwith spacing  ",
        createdAt: 2,
        renderedHtml: "<script>not stored</script>",
        credential: () => "not cloneable and not sent to storage",
      } as Parameters<PersistenceOwner["beginTurn"]>[0],
    );
    await owner.markTurnAccepted({
      projectId: project.projectId,
      conversationId: project.conversationId,
      turnId: "turn-1",
      nativeTurnId: "native-turn-1",
      acceptedAt: 3,
    });
    await owner.appendAssistantDelta(
      {
        projectId: project.projectId,
        conversationId: project.conversationId,
        turnId: "turn-1",
        sequence: 0,
        delta: "first ",
        dom: { unsafe: true },
      } as Parameters<PersistenceOwner["appendAssistantDelta"]>[0],
    );
    await owner.appendAssistantDelta({
      projectId: project.projectId,
      conversationId: project.conversationId,
      turnId: "turn-1",
      sequence: 1,
      delta: "second",
    });
    await owner.finishTurn({
      projectId: project.projectId,
      conversationId: project.conversationId,
      turnId: "turn-1",
      status: "completed",
      terminalAt: 4,
    });
    await owner.close();

    owner = await PersistenceOwner.open(path);
    const snapshot = await owner.readConversation(project);
    assert.ok(snapshot);
    assert.equal(snapshot.project.canonicalRoot, project.canonicalRoot);
    assert.equal(snapshot.conversation.nativeThreadId, "native-thread-1");
    assert.equal(snapshot.conversation.nativeResumeState, "resumable");
    assert.equal(snapshot.turns[0].prompt, "  literal prompt\nwith spacing  ");
    assert.equal(snapshot.turns[0].assistantSource, "first second");
    assert.equal(snapshot.turns[0].deltaCount, 2);
    assert.equal(snapshot.turns[0].terminalStatus, "completed");
    assert.equal("renderedHtml" in snapshot.turns[0], false);
    assert.equal("dom" in snapshot.turns[0], false);
    assert.equal("credential" in snapshot.turns[0], false);
    await owner.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.equal(version.user_version, LATEST_SCHEMA_VERSION);
    const columns = db.prepare(
      `SELECT name FROM pragma_table_info('turns')
       UNION ALL SELECT name FROM pragma_table_info('assistant_deltas')`,
    ).all().map((row) => String(row.name));
    assert.equal(
      columns.some((column) =>
        /html|dom|credential|token|environment|secret/i.test(column)
      ),
      false,
    );
    db.close();
  });
});

Deno.test("forward migration from schema 1 is deterministic and preserves rows", async () => {
  const schemas: string[] = [];
  for (const _suffix of ["a", "b"]) {
    await withDatabase(async (path) => {
      const db = new DatabaseSync(path);
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY NOT NULL,
          canonical_root TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL CHECK(created_at >= 0)
        ) STRICT;
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL UNIQUE
            REFERENCES projects(id) ON DELETE CASCADE,
          native_thread_id TEXT UNIQUE,
          native_resume_state TEXT NOT NULL DEFAULT 'unstarted'
            CHECK(native_resume_state IN ('unstarted', 'resumable', 'non_resumable')),
          native_resume_failure TEXT
            CHECK(native_resume_failure IN ('missing', 'incompatible', 'resume_failed')),
          created_at INTEGER NOT NULL CHECK(created_at >= 0),
          CHECK(
            (native_resume_state = 'unstarted' AND native_thread_id IS NULL
              AND native_resume_failure IS NULL)
            OR
            (native_resume_state = 'resumable' AND native_thread_id IS NOT NULL
              AND native_resume_failure IS NULL)
            OR
            (native_resume_state = 'non_resumable'
              AND native_resume_failure IS NOT NULL)
          )
        ) STRICT;
        CREATE TABLE preferences (
          key TEXT PRIMARY KEY NOT NULL,
          value_json TEXT NOT NULL CHECK(json_valid(value_json)),
          updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
        ) STRICT;
        INSERT INTO projects VALUES ('project-v1', '/repo/v1', 1);
        INSERT INTO conversations
          (id, project_id, native_resume_state, created_at)
          VALUES ('conversation-v1', 'project-v1', 'unstarted', 1);
        PRAGMA user_version = 1;
      `);
      db.close();

      const owner = await PersistenceOwner.open(path);
      const snapshot = await owner.readConversation({
        projectId: "project-v1",
        conversationId: "conversation-v1",
      });
      assert.ok(snapshot);
      assert.deepEqual(snapshot.turns, []);
      await owner.close();

      const migrated = new DatabaseSync(path, { readOnly: true });
      const version = migrated.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      assert.equal(version.user_version, LATEST_SCHEMA_VERSION);
      const schema = migrated.prepare(
        `SELECT name, sql FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      ).all();
      schemas.push(JSON.stringify(schema));
      migrated.close();
    });
  }
  assert.equal(schemas[0], schemas[1]);
});

Deno.test("failed transactions expose no half-created project, conversation, turn, or terminal", async () => {
  await withDatabase(async (path) => {
    const owner = await PersistenceOwner.open(path);
    const first = projectInput("first");
    await owner.createProjectWithConversation(first);
    await assert.rejects(
      () =>
        owner.createProjectWithConversation({
          projectId: "project-rolled-back",
          conversationId: first.conversationId,
          canonicalRoot: "/repo/rolled-back",
          createdAt: 2,
        }),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage_conflict" &&
        error.action.includes("database"),
    );
    assert.equal(
      await owner.readConversation({
        projectId: "project-rolled-back",
        conversationId: first.conversationId,
      }),
      null,
    );
    await owner.beginTurn({
      projectId: first.projectId,
      conversationId: first.conversationId,
      turnId: "turn-atomic",
      ordinal: 0,
      prompt: "literal atomic prompt",
      createdAt: 3,
    });
    await assert.rejects(
      () =>
        owner.finishTurn({
          projectId: first.projectId,
          conversationId: first.conversationId,
          turnId: "turn-atomic",
          status: "completed",
          terminalAt: 4,
        }),
      (error) =>
        error instanceof StorageError && error.code === "storage_state",
    );
    let snapshot = await owner.readConversation(first);
    assert.ok(snapshot);
    assert.equal(snapshot.turns.length, 1);
    assert.equal(snapshot.turns[0].phase, "pending");
    assert.equal(snapshot.turns[0].terminalStatus, null);

    await owner.markTurnAccepted({
      projectId: first.projectId,
      conversationId: first.conversationId,
      turnId: "turn-atomic",
      nativeTurnId: "native-atomic",
      acceptedAt: 5,
    });
    await owner.finishTurn({
      projectId: first.projectId,
      conversationId: first.conversationId,
      turnId: "turn-atomic",
      status: "completed",
      terminalAt: 6,
    });
    await assert.rejects(
      () =>
        owner.beginTurn({
          projectId: first.projectId,
          conversationId: first.conversationId,
          turnId: "turn-rolled-back",
          ordinal: 0,
          prompt: "duplicate ordinal",
          createdAt: 7,
        }),
      (error) =>
        error instanceof StorageError && error.code === "storage_conflict",
    );
    snapshot = await owner.readConversation(first);
    assert.ok(snapshot);
    assert.equal(snapshot.turns.length, 1);
    assert.equal(snapshot.turns[0].terminalStatus, "completed");
    await owner.close();

    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM projects").get()?.count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM conversations").get()?.count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM turns").get()?.count,
      1,
    );
    db.close();
  });
});

Deno.test("unsupported and corrupt storage fail actionably without changing bytes", async () => {
  await withDatabase(async (path) => {
    const newer = new DatabaseSync(path);
    newer.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    newer.close();
    const before = await Deno.readFile(path);
    await assert.rejects(
      () => PersistenceOwner.open(path),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage_incompatible" &&
        /do not replace/i.test(error.action),
    );
    assert.deepEqual(await Deno.readFile(path), before);
  });

  await withDatabase(async (path) => {
    const corrupt = new TextEncoder().encode(
      "recoverable bytes that are deliberately not sqlite",
    );
    await Deno.writeFile(path, corrupt);
    await assert.rejects(
      () => PersistenceOwner.open(path),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage_corrupt" &&
        /preserve/i.test(error.action),
    );
    assert.deepEqual(await Deno.readFile(path), corrupt);
  });
});

Deno.test("one serialized owner controls each database connection", async () => {
  await withDatabase(async (path) => {
    const owner = await PersistenceOwner.open(path);
    await assert.rejects(
      () => PersistenceOwner.open(path),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage_owner" &&
        /existing owner/i.test(error.action),
    );
    const alias = `${path}.alias`;
    await Deno.symlink(path, alias);
    await assert.rejects(
      () => PersistenceOwner.open(alias),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage_owner",
    );
    await owner.close();
    const reopened = await PersistenceOwner.open(path);
    await reopened.close();
  });
});

Deno.test("delta transactions reject reordering, duplication, and cross-project attachment", async () => {
  await withDatabase(async (path) => {
    const owner = await PersistenceOwner.open(path);
    const first = projectInput("scope-a");
    const second = projectInput("scope-b");
    await owner.createProjectWithConversation(first);
    await owner.createProjectWithConversation(second);
    await owner.beginTurn({
      projectId: first.projectId,
      conversationId: first.conversationId,
      turnId: "turn-scope",
      ordinal: 0,
      prompt: "literal",
      createdAt: 2,
    });
    await owner.markTurnAccepted({
      projectId: first.projectId,
      conversationId: first.conversationId,
      turnId: "turn-scope",
      nativeTurnId: "native-scope",
      acceptedAt: 3,
    });

    await assert.rejects(
      () =>
        owner.appendAssistantDelta({
          projectId: first.projectId,
          conversationId: first.conversationId,
          turnId: "turn-scope",
          sequence: 1,
          delta: "late",
        }),
      (error) =>
        error instanceof StorageError && error.code === "storage_sequence",
    );
    await assert.rejects(
      () =>
        owner.appendAssistantDelta({
          projectId: second.projectId,
          conversationId: first.conversationId,
          turnId: "turn-scope",
          sequence: 0,
          delta: "crossed",
        }),
      (error) =>
        error instanceof StorageError && error.code === "storage_scope",
    );
    await owner.appendAssistantDelta({
      projectId: first.projectId,
      conversationId: first.conversationId,
      turnId: "turn-scope",
      sequence: 0,
      delta: "once",
    });
    await assert.rejects(
      () =>
        owner.appendAssistantDelta({
          projectId: first.projectId,
          conversationId: first.conversationId,
          turnId: "turn-scope",
          sequence: 0,
          delta: "duplicate",
        }),
      (error) =>
        error instanceof StorageError && error.code === "storage_sequence",
    );

    const snapshot = await owner.readConversation(first);
    assert.ok(snapshot);
    assert.equal(snapshot.turns[0].assistantSource, "once");
    assert.equal(snapshot.turns[0].deltaCount, 1);
    assert.equal(snapshot.turns[0].terminalStatus, null);
    await owner.close();
  });
});

Deno.test("session-loss reconciliation preserves every native phase without replay or false completion", async () => {
  await withDatabase(async (path) => {
    const owner = await PersistenceOwner.open(path);
    const phases: readonly TurnPhase[] = [
      "pending",
      "accepted",
      "streaming",
      "completed",
      "interrupted",
      "failed",
    ];
    for (const [index, phase] of phases.entries()) {
      const project = projectInput(`reconcile-${phase}`);
      await owner.createProjectWithConversation(project);
      await owner.beginTurn({
        projectId: project.projectId,
        conversationId: project.conversationId,
        turnId: `turn-${phase}`,
        ordinal: 0,
        prompt: `prompt-${phase}`,
        createdAt: 10 + index,
      });
      if (phase !== "pending") {
        await owner.markTurnAccepted({
          projectId: project.projectId,
          conversationId: project.conversationId,
          turnId: `turn-${phase}`,
          nativeTurnId: `native-${phase}`,
          acceptedAt: 20 + index,
        });
      }
      if (phase === "streaming") {
        await owner.appendAssistantDelta({
          projectId: project.projectId,
          conversationId: project.conversationId,
          turnId: `turn-${phase}`,
          sequence: 0,
          delta: "partial",
        });
      }
      if (
        phase === "completed" || phase === "interrupted" || phase === "failed"
      ) {
        await owner.finishTurn({
          projectId: project.projectId,
          conversationId: project.conversationId,
          turnId: `turn-${phase}`,
          status: phase as TerminalStatus,
          terminalAt: 30 + index,
        });
      }
      const reason = index % 2 === 0 ? "clean_close" : "crash";
      const snapshot = await owner.reconcileAfterSessionLoss({
        projectId: project.projectId,
        conversationId: project.conversationId,
        reason,
      });
      const turn = snapshot.turns[0];
      assert.equal(turn.phase, phase);
      assert.equal(turn.prompt, `prompt-${phase}`);
      assert.equal(snapshot.turns.length, 1);
      if (phase === "pending") {
        assert.equal(turn.recoveryDisposition, "uncertain_acceptance");
        assert.equal(turn.terminalStatus, null);
      } else if (phase === "accepted") {
        assert.equal(turn.recoveryDisposition, "incomplete_accepted");
        assert.equal(turn.terminalStatus, null);
      } else if (phase === "streaming") {
        assert.equal(turn.recoveryDisposition, "incomplete_stream");
        assert.equal(turn.assistantSource, "partial");
        assert.equal(turn.terminalStatus, null);
      } else {
        assert.equal(turn.recoveryDisposition, null);
        assert.equal(turn.sessionLossReason, null);
        assert.equal(turn.terminalStatus, phase);
      }
      if (turn.recoveryDisposition !== null) {
        assert.equal(turn.sessionLossReason, reason);
      }
    }
    await owner.close();
  });
});

Deno.test("removal forgets only Vantage state and re-add is fresh", async () => {
  await withDatabase(async (path) => {
    const owner = await PersistenceOwner.open(path);
    const oldProject = projectInput("old", "/repo/shared");
    await owner.createProjectWithConversation(oldProject);
    await owner.setNativeThread({
      projectId: oldProject.projectId,
      conversationId: oldProject.conversationId,
      nativeThreadId: "native-retained-externally",
    });
    await owner.removeProject(oldProject.projectId);
    assert.equal(await owner.readConversation(oldProject), null);

    const readded = projectInput("new", "/repo/shared");
    await owner.createProjectWithConversation(readded);
    const snapshot = await owner.readConversation(readded);
    assert.ok(snapshot);
    assert.equal(snapshot.conversation.nativeThreadId, null);
    assert.equal(snapshot.conversation.nativeResumeState, "unstarted");
    assert.deepEqual(snapshot.turns, []);
    await owner.close();
  });
});
