import { DatabaseSync } from "node:sqlite";
import {
  type AppendAssistantDeltaInput,
  type BeginTurnInput,
  type ConversationRecord,
  type ConversationSnapshot,
  type CreateProjectInput,
  type FinishTurnInput,
  LATEST_SCHEMA_VERSION,
  type MarkNativeNonResumableInput,
  type MarkTurnAcceptedInput,
  type PersistenceOperation,
  type PersistenceRequest,
  type PersistenceResponse,
  type ProjectRecord,
  type ProjectRegistrySnapshot,
  type ReconcileInput,
  type RegisteredProjectRecord,
  type ScopedConversationInput,
  type SerializedStorageError,
  type SetNativeThreadInput,
  type TurnRecord,
} from "./persistence_protocol.ts";

interface PersistenceWorkerScope {
  onmessage: ((event: MessageEvent<PersistenceRequest>) => void) | null;
  postMessage(message: PersistenceResponse): void;
}

const workerScope = self as unknown as PersistenceWorkerScope;
let database: DatabaseSync | null = null;
let queue = Promise.resolve();

workerScope.onmessage = (event: MessageEvent<PersistenceRequest>) => {
  queue = queue.then(() => handleRequest(event.data));
};

function handleRequest(request: PersistenceRequest): void {
  try {
    const value = perform(request.operation);
    const response: PersistenceResponse = {
      id: request.id,
      ok: true,
      value,
    };
    workerScope.postMessage(response);
  } catch (error) {
    const response: PersistenceResponse = {
      id: request.id,
      ok: false,
      error: classifyStorageError(error),
    };
    workerScope.postMessage(response);
  }
}

function perform(operation: PersistenceOperation): unknown {
  if (operation.type === "open") {
    openDatabase(operation.path);
    return undefined;
  }
  if (operation.type === "close") {
    database?.close();
    database = null;
    return undefined;
  }
  const db = requireDatabase();
  switch (operation.type) {
    case "create_project":
      return createProject(db, operation.input);
    case "remove_project":
      return removeProject(
        db,
        operation.projectId,
        operation.nextSelectedProjectId,
        operation.updatedAt,
      );
    case "set_selected_project":
      return setSelectedProject(
        db,
        operation.projectId,
        operation.updatedAt,
      );
    case "read_project_registry":
      return readProjectRegistry(db);
    case "set_native_thread":
      return setNativeThread(db, operation.input);
    case "mark_native_non_resumable":
      return markNativeNonResumable(db, operation.input);
    case "begin_turn":
      return beginTurn(db, operation.input);
    case "mark_turn_accepted":
      return markTurnAccepted(db, operation.input);
    case "append_assistant_delta":
      return appendAssistantDelta(db, operation.input);
    case "finish_turn":
      return finishTurn(db, operation.input);
    case "reconcile":
      return reconcile(db, operation.input);
    case "read_conversation":
      return readConversation(db, operation.input);
  }
}

function openDatabase(path: string): void {
  if (database !== null) {
    throw storageFailure(
      "storage_owner",
      "The persistence worker already owns a database connection.",
      "Close the current owner before opening another database.",
    );
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    const integrity = db.prepare("PRAGMA quick_check").get() as
      | Record<string, unknown>
      | undefined;
    if (!integrity || Object.values(integrity)[0] !== "ok") {
      throw storageFailure(
        "storage_corrupt",
        "Vantage storage failed its integrity check.",
        "Preserve the database file and restore or inspect it before retrying.",
      );
    }
    const versionRow = db.prepare("PRAGMA user_version").get() as
      | Record<string, unknown>
      | undefined;
    const version = Number(versionRow?.user_version);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error("SQLite returned an invalid schema version");
    }
    if (version > LATEST_SCHEMA_VERSION) {
      throw storageFailure(
        "storage_incompatible",
        `Vantage storage schema ${version} is newer than supported schema ${LATEST_SCHEMA_VERSION}.`,
        "Open this database with a compatible newer Vantage build; do not replace it.",
      );
    }
    migrate(db, version);
    database = db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the original actionable failure.
    }
    if (isSerializedStorageError(error)) throw error;
    throw storageFailure(
      looksCorrupt(error) ? "storage_corrupt" : "storage_open",
      looksCorrupt(error)
        ? "Vantage storage is corrupt or is not a SQLite database."
        : "Vantage could not open its local storage.",
      "Preserve the existing database bytes, inspect or restore them, then retry.",
    );
  }
}

function migrate(db: DatabaseSync, fromVersion: number): void {
  const migrations: readonly string[] = [
    `
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
    `,
    `
      CREATE TABLE turns (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL
          REFERENCES conversations(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        prompt TEXT NOT NULL,
        phase TEXT NOT NULL
          CHECK(phase IN (
            'pending', 'accepted', 'streaming',
            'completed', 'interrupted', 'failed'
          )),
        native_turn_id TEXT,
        terminal_status TEXT
          CHECK(terminal_status IN ('completed', 'interrupted', 'failed')),
        recovery_disposition TEXT
          CHECK(recovery_disposition IN (
            'uncertain_acceptance', 'incomplete_accepted', 'incomplete_stream'
          )),
        session_loss_reason TEXT
          CHECK(session_loss_reason IN ('clean_close', 'crash')),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        accepted_at INTEGER CHECK(accepted_at >= 0),
        terminal_at INTEGER CHECK(terminal_at >= 0),
        UNIQUE(conversation_id, ordinal),
        UNIQUE(conversation_id, native_turn_id),
        CHECK(
          (phase = 'pending' AND native_turn_id IS NULL AND accepted_at IS NULL)
          OR
          (phase IN ('accepted', 'streaming')
            AND native_turn_id IS NOT NULL AND accepted_at IS NOT NULL)
          OR
          (phase IN ('completed', 'interrupted', 'failed')
            AND native_turn_id IS NOT NULL AND accepted_at IS NOT NULL
            AND terminal_status = phase AND terminal_at IS NOT NULL)
        ),
        CHECK(
          (recovery_disposition IS NULL AND session_loss_reason IS NULL)
          OR
          (recovery_disposition IS NOT NULL AND session_loss_reason IS NOT NULL
            AND terminal_status IS NULL)
        )
      ) STRICT;

      CREATE TABLE assistant_deltas (
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        source TEXT NOT NULL,
        PRIMARY KEY(turn_id, sequence)
      ) STRICT;
    `,
  ];

  for (let index = fromVersion; index < migrations.length; index++) {
    transaction(db, () => {
      db.exec(migrations[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    });
  }
}

function createProject(db: DatabaseSync, input: CreateProjectInput): void {
  transaction(db, () => {
    db.prepare(
      "INSERT INTO projects (id, canonical_root, created_at) VALUES (?, ?, ?)",
    ).run(input.projectId, input.canonicalRoot, input.createdAt);
    db.prepare(
      `INSERT INTO conversations
        (id, project_id, native_resume_state, created_at)
       VALUES (?, ?, 'unstarted', ?)`,
    ).run(input.conversationId, input.projectId, input.createdAt);
  });
}

const SELECTED_PROJECT_PREFERENCE = "selected_project_id";

function removeProject(
  db: DatabaseSync,
  projectId: string,
  nextSelectedProjectId?: string | null,
  updatedAt?: number,
): void {
  transaction(db, () => {
    const result = db.prepare("DELETE FROM projects WHERE id = ?").run(
      projectId,
    );
    if (result.changes !== 1) throw scopeFailure();
    if (nextSelectedProjectId === undefined) {
      const preference = selectedProjectPreference(db);
      if (preference === projectId) {
        db.prepare("DELETE FROM preferences WHERE key = ?").run(
          SELECTED_PROJECT_PREFERENCE,
        );
      }
      return;
    }
    writeSelectedProject(db, nextSelectedProjectId, updatedAt!);
  });
}

function setSelectedProject(
  db: DatabaseSync,
  projectId: string | null,
  updatedAt: number,
): void {
  transaction(db, () => {
    writeSelectedProject(db, projectId, updatedAt);
  });
}

function writeSelectedProject(
  db: DatabaseSync,
  projectId: string | null,
  updatedAt: number,
): void {
  if (projectId === null) {
    db.prepare("DELETE FROM preferences WHERE key = ?").run(
      SELECTED_PROJECT_PREFERENCE,
    );
    return;
  }
  const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(
    projectId,
  );
  if (!exists) throw scopeFailure();
  db.prepare(
    `INSERT INTO preferences (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE
       SET value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
  ).run(SELECTED_PROJECT_PREFERENCE, JSON.stringify(projectId), updatedAt);
}

function readProjectRegistry(db: DatabaseSync): ProjectRegistrySnapshot {
  const rows = db.prepare(
    `SELECT
       p.id AS project_id, p.canonical_root, p.created_at AS project_created_at,
       c.id AS conversation_id, c.native_thread_id, c.native_resume_state,
       c.native_resume_failure, c.created_at AS conversation_created_at
     FROM projects p
     JOIN conversations c ON c.project_id = p.id
     ORDER BY p.created_at, p.id`,
  ).all() as Record<string, unknown>[];
  const projects = rows.map((row) => ({
    project: {
      id: String(row.project_id),
      canonicalRoot: String(row.canonical_root),
      createdAt: Number(row.project_created_at),
    } satisfies ProjectRecord,
    conversation: {
      id: String(row.conversation_id),
      projectId: String(row.project_id),
      nativeThreadId: nullableString(row.native_thread_id),
      nativeResumeState: row.native_resume_state,
      nativeResumeFailure: row.native_resume_failure,
      createdAt: Number(row.conversation_created_at),
    },
  } as RegisteredProjectRecord));
  const selectedProjectId = selectedProjectPreference(db);
  return {
    projects,
    selectedProjectId: selectedProjectId !== null &&
        projects.some((entry) => entry.project.id === selectedProjectId)
      ? selectedProjectId
      : null,
  };
}

function selectedProjectPreference(db: DatabaseSync): string | null {
  const row = db.prepare(
    "SELECT value_json FROM preferences WHERE key = ?",
  ).get(SELECTED_PROJECT_PREFERENCE) as Record<string, unknown> | undefined;
  if (!row) return null;
  const value = JSON.parse(String(row.value_json));
  return typeof value === "string" && value.length > 0 ? value : null;
}

function setNativeThread(db: DatabaseSync, input: SetNativeThreadInput): void {
  transaction(db, () => {
    assertConversationScope(db, input);
    const result = db.prepare(
      `UPDATE conversations
       SET native_thread_id = ?, native_resume_state = 'resumable',
           native_resume_failure = NULL
       WHERE id = ? AND project_id = ?`,
    ).run(input.nativeThreadId, input.conversationId, input.projectId);
    if (result.changes !== 1) throw scopeFailure();
  });
}

function markNativeNonResumable(
  db: DatabaseSync,
  input: MarkNativeNonResumableInput,
): void {
  transaction(db, () => {
    assertConversationScope(db, input);
    const result = db.prepare(
      `UPDATE conversations
       SET native_resume_state = 'non_resumable', native_resume_failure = ?
       WHERE id = ? AND project_id = ?`,
    ).run(input.failure, input.conversationId, input.projectId);
    if (result.changes !== 1) throw scopeFailure();
  });
}

function beginTurn(
  db: DatabaseSync,
  input: BeginTurnInput,
): void {
  transaction(db, () => {
    assertConversationScope(db, input);
    const unresolved = db.prepare(
      `SELECT 1
       FROM turns
       WHERE conversation_id = ?
         AND phase IN ('pending', 'accepted', 'streaming')
       LIMIT 1`,
    ).get(input.conversationId);
    if (unresolved) {
      throw storageFailure(
        "storage_state",
        "The conversation already has an unresolved turn.",
        "Reconcile that turn before recording another prompt.",
      );
    }
    db.prepare(
      `INSERT INTO turns
        (id, conversation_id, ordinal, prompt, phase, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(
      input.turnId,
      input.conversationId,
      input.ordinal,
      input.prompt,
      input.createdAt,
    );
  });
}

function markTurnAccepted(
  db: DatabaseSync,
  input: MarkTurnAcceptedInput,
): void {
  transaction(db, () => {
    assertTurnScope(db, input);
    const result = db.prepare(
      `UPDATE turns
       SET phase = 'accepted', native_turn_id = ?, accepted_at = ?
       WHERE id = ? AND conversation_id = ? AND phase = 'pending'
         AND recovery_disposition IS NULL`,
    ).run(
      input.nativeTurnId,
      input.acceptedAt,
      input.turnId,
      input.conversationId,
    );
    if (result.changes !== 1) throw stateFailure("pending", "accepted");
  });
}

function appendAssistantDelta(
  db: DatabaseSync,
  input: AppendAssistantDeltaInput,
): void {
  transaction(db, () => {
    const turn = assertTurnScope(db, input);
    if (turn.phase !== "accepted" && turn.phase !== "streaming") {
      throw stateFailure("accepted or streaming", "append assistant source");
    }
    if (turn.recovery_disposition !== null) {
      throw storageFailure(
        "storage_state",
        "Recovered turns cannot accept late assistant source.",
        "Resume and reconcile the exact native thread before accepting new events.",
      );
    }
    const count = db.prepare(
      "SELECT COUNT(*) AS count FROM assistant_deltas WHERE turn_id = ?",
    ).get(input.turnId) as Record<string, unknown>;
    if (Number(count.count) !== input.sequence) {
      throw storageFailure(
        "storage_sequence",
        `Assistant delta ${input.sequence} is duplicate or out of order.`,
        "Stop this live session and reconcile it without replaying the prompt.",
      );
    }
    db.prepare(
      "INSERT INTO assistant_deltas (turn_id, sequence, source) VALUES (?, ?, ?)",
    ).run(input.turnId, input.sequence, input.delta);
    db.prepare(
      "UPDATE turns SET phase = 'streaming' WHERE id = ?",
    ).run(input.turnId);
  });
}

function finishTurn(db: DatabaseSync, input: FinishTurnInput): void {
  transaction(db, () => {
    assertTurnScope(db, input);
    const result = db.prepare(
      `UPDATE turns
       SET phase = ?, terminal_status = ?, terminal_at = ?
       WHERE id = ? AND conversation_id = ?
         AND phase IN ('accepted', 'streaming')
         AND recovery_disposition IS NULL`,
    ).run(
      input.status,
      input.status,
      input.terminalAt,
      input.turnId,
      input.conversationId,
    );
    if (result.changes !== 1) {
      throw stateFailure("accepted or streaming", input.status);
    }
  });
}

function reconcile(
  db: DatabaseSync,
  input: ReconcileInput,
): ConversationSnapshot {
  transaction(db, () => {
    assertConversationScope(db, input);
    db.prepare(
      `UPDATE turns
       SET recovery_disposition = CASE phase
         WHEN 'pending' THEN 'uncertain_acceptance'
         WHEN 'accepted' THEN 'incomplete_accepted'
         WHEN 'streaming' THEN 'incomplete_stream'
       END,
       session_loss_reason = ?
       WHERE conversation_id = ?
         AND phase IN ('pending', 'accepted', 'streaming')
         AND recovery_disposition IS NULL`,
    ).run(input.reason, input.conversationId);
  });
  return readConversation(db, input)!;
}

function readConversation(
  db: DatabaseSync,
  input: ScopedConversationInput,
): ConversationSnapshot | null {
  const projectRow = db.prepare(
    `SELECT p.id, p.canonical_root, p.created_at
     FROM projects p
     JOIN conversations c ON c.project_id = p.id
     WHERE p.id = ? AND c.id = ?`,
  ).get(input.projectId, input.conversationId) as
    | Record<string, unknown>
    | undefined;
  if (!projectRow) return null;
  const conversationRow = db.prepare(
    `SELECT id, project_id, native_thread_id, native_resume_state,
            native_resume_failure, created_at
     FROM conversations WHERE id = ? AND project_id = ?`,
  ).get(input.conversationId, input.projectId) as Record<string, unknown>;
  const turnRows = db.prepare(
    `SELECT id, conversation_id, ordinal, prompt, phase, native_turn_id,
            terminal_status, recovery_disposition, session_loss_reason,
            created_at, accepted_at, terminal_at
     FROM turns WHERE conversation_id = ? ORDER BY ordinal`,
  ).all(input.conversationId) as Record<string, unknown>[];
  const turns = turnRows.map((row) => {
    const deltaRows = db.prepare(
      `SELECT source FROM assistant_deltas
       WHERE turn_id = ? ORDER BY sequence`,
    ).all(String(row.id)) as Record<string, unknown>[];
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      ordinal: Number(row.ordinal),
      prompt: String(row.prompt),
      phase: row.phase,
      nativeTurnId: nullableString(row.native_turn_id),
      assistantSource: deltaRows.map((delta) => String(delta.source)).join(""),
      deltaCount: deltaRows.length,
      terminalStatus: row.terminal_status,
      recoveryDisposition: row.recovery_disposition,
      sessionLossReason: row.session_loss_reason,
      createdAt: Number(row.created_at),
      acceptedAt: nullableNumber(row.accepted_at),
      terminalAt: nullableNumber(row.terminal_at),
    } as TurnRecord;
  });
  return {
    project: {
      id: String(projectRow.id),
      canonicalRoot: String(projectRow.canonical_root),
      createdAt: Number(projectRow.created_at),
    } satisfies ProjectRecord,
    conversation: {
      id: String(conversationRow.id),
      projectId: String(conversationRow.project_id),
      nativeThreadId: nullableString(conversationRow.native_thread_id),
      nativeResumeState: conversationRow.native_resume_state,
      nativeResumeFailure: conversationRow.native_resume_failure,
      createdAt: Number(conversationRow.created_at),
    } as ConversationRecord,
    turns,
  };
}

function assertConversationScope(
  db: DatabaseSync,
  input: ScopedConversationInput,
): void {
  const row = db.prepare(
    "SELECT 1 FROM conversations WHERE id = ? AND project_id = ?",
  ).get(input.conversationId, input.projectId);
  if (!row) throw scopeFailure();
}

function assertTurnScope(
  db: DatabaseSync,
  input: ScopedConversationInput & { readonly turnId: string },
): Record<string, unknown> {
  const row = db.prepare(
    `SELECT t.phase, t.recovery_disposition
     FROM turns t
     JOIN conversations c ON c.id = t.conversation_id
     WHERE t.id = ? AND t.conversation_id = ?
       AND c.project_id = ?`,
  ).get(input.turnId, input.conversationId, input.projectId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw scopeFailure();
  return row;
}

function transaction(db: DatabaseSync, operation: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    operation();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the operation failure.
    }
    throw error;
  }
}

function requireDatabase(): DatabaseSync {
  if (database === null) {
    throw storageFailure(
      "storage_owner",
      "The persistence owner has no open database.",
      "Open Vantage storage before accessing saved state.",
    );
  }
  return database;
}

function scopeFailure(): SerializedStorageError {
  return storageFailure(
    "storage_scope",
    "Saved conversation data does not belong to the requested project.",
    "Stop the live session and reload the selected project's snapshot.",
  );
}

function stateFailure(
  expected: string,
  attempted: string,
): SerializedStorageError {
  return storageFailure(
    "storage_state",
    `A turn must be ${expected} before it can transition to ${attempted}.`,
    "Stop the live session and reconcile the durable turn without replaying its prompt.",
  );
}

function storageFailure(
  code: string,
  message: string,
  action: string,
): SerializedStorageError {
  return { code, message, action };
}

function classifyStorageError(error: unknown): SerializedStorageError {
  if (isSerializedStorageError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/unique constraint failed/i.test(message)) {
    return storageFailure(
      "storage_conflict",
      "Saved state conflicts with an existing project, conversation, turn, or native identity.",
      "Reload saved state and use fresh Vantage identities without replacing the database.",
    );
  }
  if (/constraint failed|foreign key constraint/i.test(message)) {
    return storageFailure(
      "storage_state",
      "Saved state rejected an invalid or incomplete transition.",
      "Preserve the database, reload its snapshot, and reconcile before retrying.",
    );
  }
  return storageFailure(
    "storage_write",
    "Vantage could not complete a local storage transaction.",
    "Preserve the database and retry after checking available disk space and permissions.",
  );
}

function isSerializedStorageError(
  value: unknown,
): value is SerializedStorageError {
  return value !== null && typeof value === "object" &&
    typeof (value as Record<string, unknown>).code === "string" &&
    typeof (value as Record<string, unknown>).message === "string" &&
    typeof (value as Record<string, unknown>).action === "string";
}

function looksCorrupt(error: unknown): boolean {
  return error instanceof Error &&
    /not a database|malformed|file is encrypted|disk image/i.test(
      error.message,
    );
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
