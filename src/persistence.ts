import type {
  AppendAssistantDeltaInput,
  BeginTurnInput,
  ConversationSnapshot,
  CreateProjectInput,
  FinishTurnInput,
  MarkNativeNonResumableInput,
  MarkTurnAcceptedInput,
  PersistenceOperation,
  PersistenceRequest,
  PersistenceResponse,
  ReconcileInput,
  ScopedConversationInput,
  SerializedStorageError,
  SetNativeThreadInput,
} from "./persistence_protocol.ts";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

const activeDatabasePaths = new Set<string>();

export class StorageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorageError";
  }
}

export class PersistenceOwner {
  readonly #worker: Worker;
  readonly #databasePath: string;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;

  private constructor(databasePath: string) {
    this.#databasePath = databasePath;
    this.#worker = new Worker(
      new URL("./persistence_worker.ts", import.meta.url).href,
      {
        type: "module",
        name: "vantage-persistence-owner",
      },
    );
    this.#worker.onmessage = (event: MessageEvent<PersistenceResponse>) => {
      this.#handleResponse(event.data);
    };
    this.#worker.onerror = (event) => {
      event.preventDefault();
      this.#breakOwner(
        new StorageError(
          "storage_owner",
          "The Vantage persistence owner stopped unexpectedly.",
          "Close Vantage, preserve the database, and retry.",
          { cause: event.error },
        ),
      );
    };
    this.#worker.onmessageerror = () => {
      this.#breakOwner(
        new StorageError(
          "storage_owner",
          "The Vantage persistence owner returned an unreadable response.",
          "Close Vantage, preserve the database, and retry.",
        ),
      );
    };
  }

  static async open(databasePath: string): Promise<PersistenceOwner> {
    const canonicalPath = await canonicalDatabasePath(databasePath);
    if (activeDatabasePaths.has(canonicalPath)) {
      throw new StorageError(
        "storage_owner",
        "This Vantage database already has a persistence owner.",
        "Reuse the existing owner or close it before opening another.",
      );
    }
    activeDatabasePaths.add(canonicalPath);
    const owner = new PersistenceOwner(canonicalPath);
    try {
      await owner.#request({ type: "open", path: canonicalPath });
      return owner;
    } catch (error) {
      owner.#closed = true;
      owner.#worker.terminate();
      activeDatabasePaths.delete(canonicalPath);
      throw error;
    }
  }

  createProjectWithConversation(input: CreateProjectInput): Promise<void> {
    validateCreateProject(input);
    return this.#voidRequest({
      type: "create_project",
      input: {
        projectId: input.projectId,
        conversationId: input.conversationId,
        canonicalRoot: input.canonicalRoot,
        createdAt: input.createdAt,
      },
    });
  }

  removeProject(projectId: string): Promise<void> {
    validateId(projectId, "project ID");
    return this.#voidRequest({ type: "remove_project", projectId });
  }

  setNativeThread(input: SetNativeThreadInput): Promise<void> {
    validateScope(input);
    validateId(input.nativeThreadId, "native thread ID");
    return this.#voidRequest({
      type: "set_native_thread",
      input: {
        projectId: input.projectId,
        conversationId: input.conversationId,
        nativeThreadId: input.nativeThreadId,
      },
    });
  }

  markNativeNonResumable(
    input: MarkNativeNonResumableInput,
  ): Promise<void> {
    validateScope(input);
    if (
      input.failure !== "missing" &&
      input.failure !== "incompatible" &&
      input.failure !== "resume_failed"
    ) {
      throw invalidInput("A recognized native resume failure is required.");
    }
    return this.#voidRequest({
      type: "mark_native_non_resumable",
      input: {
        projectId: input.projectId,
        conversationId: input.conversationId,
        failure: input.failure,
      },
    });
  }

  beginTurn(input: BeginTurnInput): Promise<void> {
    validateScope(input);
    validateId(input.turnId, "turn ID");
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
      throw invalidInput("Turn ordinal must be a non-negative integer.");
    }
    if (typeof input.prompt !== "string" || input.prompt.length === 0) {
      throw invalidInput("A literal non-empty prompt is required.");
    }
    validateTimestamp(input.createdAt);
    return this.#voidRequest({
      type: "begin_turn",
      input: {
        projectId: input.projectId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        ordinal: input.ordinal,
        prompt: input.prompt,
        createdAt: input.createdAt,
      },
    });
  }

  markTurnAccepted(input: MarkTurnAcceptedInput): Promise<void> {
    validateTurnScope(input);
    validateId(input.nativeTurnId, "native turn ID");
    validateTimestamp(input.acceptedAt);
    return this.#voidRequest({
      type: "mark_turn_accepted",
      input: {
        projectId: input.projectId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        nativeTurnId: input.nativeTurnId,
        acceptedAt: input.acceptedAt,
      },
    });
  }

  appendAssistantDelta(input: AppendAssistantDeltaInput): Promise<void> {
    validateTurnScope(input);
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw invalidInput("Assistant delta sequence must be non-negative.");
    }
    if (typeof input.delta !== "string") {
      throw invalidInput("Assistant delta must be raw text.");
    }
    return this.#voidRequest({
      type: "append_assistant_delta",
      input: {
        projectId: input.projectId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        sequence: input.sequence,
        delta: input.delta,
      },
    });
  }

  finishTurn(input: FinishTurnInput): Promise<void> {
    validateTurnScope(input);
    if (
      input.status !== "completed" &&
      input.status !== "interrupted" &&
      input.status !== "failed"
    ) {
      throw invalidInput("A recognized native terminal status is required.");
    }
    validateTimestamp(input.terminalAt);
    return this.#voidRequest({
      type: "finish_turn",
      input: {
        projectId: input.projectId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        status: input.status,
        terminalAt: input.terminalAt,
      },
    });
  }

  async reconcileAfterSessionLoss(
    input: ReconcileInput,
  ): Promise<ConversationSnapshot> {
    validateScope(input);
    if (input.reason !== "clean_close" && input.reason !== "crash") {
      throw invalidInput("A recognized session-loss reason is required.");
    }
    return await this.#request({
      type: "reconcile",
      input: {
        projectId: input.projectId,
        conversationId: input.conversationId,
        reason: input.reason,
      },
    }) as ConversationSnapshot;
  }

  async readConversation(
    input: ScopedConversationInput,
  ): Promise<ConversationSnapshot | null> {
    validateScope(input);
    return await this.#request({ type: "read_conversation", input }) as
      | ConversationSnapshot
      | null;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#voidRequest({ type: "close" });
    } finally {
      this.#closed = true;
      this.#worker.terminate();
      this.#failPending(
        new StorageError(
          "storage_owner",
          "The Vantage persistence owner is closed.",
          "Open a new owner before accessing saved state.",
        ),
      );
      activeDatabasePaths.delete(this.#databasePath);
    }
  }

  async #voidRequest(operation: PersistenceOperation): Promise<void> {
    await this.#request(operation);
  }

  #request(operation: PersistenceOperation): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(
        new StorageError(
          "storage_owner",
          "The Vantage persistence owner is closed.",
          "Open a new owner before accessing saved state.",
        ),
      );
    }
    const id = this.#nextId++;
    let rejectRequest: (reason: unknown) => void = () => {};
    const promise = new Promise<unknown>((resolve, reject) => {
      rejectRequest = reject;
      this.#pending.set(id, { resolve, reject });
    });
    const request: PersistenceRequest = { id, operation };
    try {
      this.#worker.postMessage(request);
    } catch (error) {
      const failure = new StorageError(
        "storage_owner",
        "The Vantage persistence owner could not accept an operation.",
        "Preserve the database, close Vantage, and retry.",
        { cause: error },
      );
      this.#pending.delete(id);
      rejectRequest(failure);
      this.#breakOwner(failure);
      return promise;
    }
    return promise;
  }

  #handleResponse(response: PersistenceResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.value);
    } else {
      pending.reject(fromSerializedError(response.error));
    }
  }

  #failPending(error: StorageError): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #breakOwner(error: StorageError): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
    activeDatabasePaths.delete(this.#databasePath);
    this.#failPending(error);
  }
}

async function canonicalDatabasePath(input: string): Promise<string> {
  if (typeof input !== "string" || input.length === 0) {
    throw invalidInput("A database path is required.");
  }
  const absolute = input.startsWith("/") ? input : `${Deno.cwd()}/${input}`;
  try {
    const existing = await Deno.realPath(absolute);
    if (!(await Deno.stat(existing)).isFile) {
      throw invalidInput("The database path must name a file.");
    }
    return existing;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (!(error instanceof Deno.errors.NotFound)) {
      throw new StorageError(
        "storage_open",
        "The Vantage database path is unavailable.",
        "Restore access to the existing file and retry without replacing it.",
        { cause: error },
      );
    }
  }
  const separator = absolute.lastIndexOf("/");
  const parent = separator === 0 ? "/" : absolute.slice(0, separator);
  const name = absolute.slice(separator + 1);
  if (name.length === 0 || name === "." || name === "..") {
    throw invalidInput("A database filename is required.");
  }
  let canonicalParent: string;
  try {
    canonicalParent = await Deno.realPath(parent);
  } catch (error) {
    throw new StorageError(
      "storage_open",
      "The Vantage storage directory is unavailable.",
      "Create or restore the directory, then retry without deleting any database file.",
      { cause: error },
    );
  }
  return `${canonicalParent}/${name}`;
}

function validateCreateProject(input: CreateProjectInput): void {
  validateId(input.projectId, "project ID");
  validateId(input.conversationId, "conversation ID");
  if (
    typeof input.canonicalRoot !== "string" ||
    !input.canonicalRoot.startsWith("/")
  ) {
    throw invalidInput("The project root must be a canonical absolute path.");
  }
  validateTimestamp(input.createdAt);
}

function validateTurnScope(
  input: ScopedConversationInput & { readonly turnId: string },
): void {
  validateScope(input);
  validateId(input.turnId, "turn ID");
}

function validateScope(input: ScopedConversationInput): void {
  validateId(input.projectId, "project ID");
  validateId(input.conversationId, "conversation ID");
}

function validateId(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes("\0")
  ) {
    throw invalidInput(`A valid ${label} is required.`);
  }
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidInput("A non-negative integer timestamp is required.");
  }
}

function invalidInput(message: string): StorageError {
  return new StorageError(
    "storage_input",
    message,
    "Correct the local state operation and retry.",
  );
}

function fromSerializedError(error: SerializedStorageError): StorageError {
  return new StorageError(error.code, error.message, error.action);
}
