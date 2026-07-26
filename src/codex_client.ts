import { VantageError } from "./errors.ts";
import type { TurnTerminalStatus } from "./events.ts";

type JsonObject = Record<string, unknown>;

interface RpcResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface TurnStartedSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

export interface NativeTurnEvent {
  readonly type: "accepted" | "delta" | "terminal";
  readonly nativeTurnId?: string;
  readonly delta?: string;
  readonly status?: TurnTerminalStatus;
  readonly message?: string;
  readonly action?: string;
  readonly canContinue?: boolean;
  readonly nativeTruth?: boolean;
}

export interface NativeSessionIdentity {
  readonly threadId: string | null;
  readonly resumed: boolean;
}

export interface NativeSessionRequest {
  readonly nativeThreadId?: string;
}

export interface CodexSession {
  initialize(request?: NativeSessionRequest): Promise<NativeSessionIdentity>;
  startDurableThread(): Promise<string>;
  startTurn(
    prompt: string,
    onEvent: (event: NativeTurnEvent) => void,
  ): Promise<string>;
  interruptTurn(): Promise<void>;
  shutdown(): Promise<void>;
}

export type CodexSessionFactory = (repository: string) => CodexSession;

export interface ManagedChild {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  kill(signal?: Deno.Signal): void;
}

export type ProcessSpawner = (repository: string) => ManagedChild;

const REQUEST_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 1_500;

export class AppServerCodexSession implements CodexSession {
  readonly #process: ManagedChild;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #decoder = new TextDecoder();
  readonly #encoder = new TextEncoder();
  #nextId = 1;
  #threadId: string | null = null;
  #activeTurnId: string | null = null;
  #turnSink: ((event: NativeTurnEvent) => void) | null = null;
  #turnStarted = false;
  #turnStartedSignal: TurnStartedSignal | null = null;
  #accepted = false;
  #shuttingDown = false;
  #stdoutTask: Promise<void>;
  #stderrTask: Promise<void>;

  constructor(
    readonly repository: string,
    spawner: ProcessSpawner = spawnCodex,
  ) {
    try {
      this.#process = spawner(repository);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new VantageError(
          "codex_missing",
          "Codex is not available.",
          "Install the Codex CLI or add it to PATH, then retry.",
        );
      }
      throw new VantageError(
        "codex_start",
        "Codex could not be launched.",
        "Check your local Codex installation, then retry.",
      );
    }

    this.#writer = this.#process.stdin.getWriter();
    this.#stdoutTask = this.#readStdout();
    this.#stderrTask = drain(this.#process.stderr);
    void this.#watchExit();
  }

  async initialize(
    request: NativeSessionRequest = {},
  ): Promise<NativeSessionIdentity> {
    try {
      await this.#request("initialize", {
        clientInfo: {
          name: "vantage",
          title: "Vantage",
          version: "0.1.0",
        },
      });
      await this.#notify("initialized", {});

      const account = asObject(
        await this.#request("account/read", {
          refreshToken: false,
        }),
      );
      if (account.requiresOpenaiAuth === true && account.account === null) {
        throw new VantageError(
          "authentication",
          "Codex is not authenticated.",
          "Run `codex login` outside Vantage, then retry.",
        );
      }

      if (request.nativeThreadId === undefined) {
        return { threadId: null, resumed: false };
      }
      const resumed = true;
      const started = asObject(
        await this.#request("thread/resume", {
          threadId: request.nativeThreadId,
          cwd: this.repository,
          approvalPolicy: "never",
          sandbox: "read-only",
        }),
      );
      const thread = asObject(started.thread);
      if (typeof thread.id !== "string" || thread.id.length === 0) {
        throw new Error(
          `${
            resumed ? "thread/resume" : "thread/start"
          } did not return a thread id`,
        );
      }
      if (resumed && thread.id !== request.nativeThreadId) {
        throw new VantageError(
          "native_incompatible",
          "Codex resumed a different native conversation.",
          "Keep the saved transcript read-only and remove the project or retry the exact native resume.",
        );
      }
      if (started.cwd !== undefined && started.cwd !== this.repository) {
        if (resumed) {
          throw new VantageError(
            "native_incompatible",
            "The saved native conversation belongs to an incompatible repository history.",
            "Restore the original repository or remove the saved project.",
          );
        }
        throw new Error(
          "thread/start returned an unexpected working directory",
        );
      }
      this.#threadId = thread.id;
      return { threadId: thread.id, resumed };
    } catch (error) {
      if (error instanceof VantageError) throw error;
      if (request.nativeThreadId !== undefined) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not found|missing|unknown thread/i.test(message)) {
          throw new VantageError(
            "native_missing",
            "The saved native Codex conversation is missing.",
            "Keep this transcript read-only, retry the exact native resume, or remove the project.",
          );
        }
        throw new VantageError(
          "native_resume_failed",
          "Vantage could not resume the saved native Codex conversation.",
          "Retry the exact native resume after checking Codex authentication and history.",
        );
      }
      throw new VantageError(
        "codex_start",
        "Codex could not initialize a repository session.",
        "Check your Codex installation and authentication, then retry.",
      );
    }
  }

  async startDurableThread(): Promise<string> {
    if (this.#threadId !== null) return this.#threadId;
    try {
      const started = asObject(
        await this.#request("thread/start", {
          cwd: this.repository,
          ephemeral: false,
          approvalPolicy: "never",
          sandbox: "read-only",
        }),
      );
      const thread = asObject(started.thread);
      if (typeof thread.id !== "string" || thread.id.length === 0) {
        throw new Error("thread/start did not return a thread id");
      }
      if (started.cwd !== this.repository) {
        throw new Error(
          "thread/start returned an unexpected working directory",
        );
      }
      this.#threadId = thread.id;
      return thread.id;
    } catch {
      throw new VantageError(
        "codex_start",
        "Codex could not create a durable conversation.",
        "Check Codex and local storage, then retry without replaying the prompt.",
      );
    }
  }

  async startTurn(
    prompt: string,
    onEvent: (event: NativeTurnEvent) => void,
  ): Promise<string> {
    if (this.#threadId === null) {
      throw new VantageError(
        "turn",
        "The Codex session is not ready.",
        "Retry the repository session.",
      );
    }
    if (this.#turnSink !== null) {
      throw new VantageError(
        "turn",
        "A Codex turn is already active.",
        "Wait for the current turn to finish.",
      );
    }

    this.#turnSink = onEvent;
    this.#turnStarted = false;
    this.#turnStartedSignal = Promise.withResolvers<void>();
    this.#accepted = false;
    try {
      const response = asObject(
        await this.#request("turn/start", {
          threadId: this.#threadId,
          cwd: this.repository,
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            networkAccess: false,
          },
          input: [{ type: "text", text: prompt }],
        }),
      );
      const turn = asObject(response.turn);
      if (typeof turn.id !== "string" || turn.id.length === 0) {
        throw new Error("turn/start did not return a turn id");
      }
      this.#activeTurnId = turn.id;
      this.#emitAccepted();
      return turn.id;
    } catch (error) {
      this.#turnStartedSignal?.resolve();
      this.#turnStartedSignal = null;
      this.#turnStarted = false;
      this.#turnSink = null;
      this.#activeTurnId = null;
      if (isUnauthorized(error)) {
        throw new VantageError(
          "authentication",
          "Codex authentication is unavailable or expired.",
          "Run `codex login` outside Vantage, then retry.",
        );
      }
      throw new VantageError(
        "turn",
        "Codex did not accept the prompt.",
        "Check Codex outside Vantage, then retry the session.",
      );
    }
  }

  async interruptTurn(): Promise<void> {
    if (this.#threadId === null) {
      throw new VantageError(
        "turn",
        "The Codex session is not ready.",
        "Retry the repository session.",
      );
    }
    if (this.#turnSink === null) return;

    if (!this.#turnStarted && this.#turnStartedSignal) {
      await this.#turnStartedSignal.promise;
    }
    if (this.#turnSink === null || this.#activeTurnId === null) return;

    try {
      await this.#request("turn/interrupt", {
        threadId: this.#threadId,
        turnId: this.#activeTurnId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /no active turn to interrupt/i.test(error.message)
      ) {
        return;
      }
      throw new VantageError(
        "turn",
        "Codex could not confirm the stop request.",
        "Retry the repository session before sending another prompt.",
      );
    }
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) {
      await Promise.allSettled([this.#stdoutTask, this.#stderrTask]);
      return;
    }
    this.#shuttingDown = true;
    this.#turnStartedSignal?.resolve();
    this.#turnStartedSignal = null;
    this.#rejectPending(new Error("Codex session closed"));

    try {
      this.#writer.releaseLock();
    } catch {
      // The stream may already be closed by an exited process.
    }

    const exited = this.#process.status.then(() => true, () => true);
    try {
      this.#process.kill("SIGTERM");
    } catch {
      // Already exited.
    }

    if (!(await settleWithin(exited, SHUTDOWN_GRACE_MS))) {
      try {
        this.#process.kill("SIGKILL");
      } catch {
        // Already exited between the timeout and escalation.
      }
      await exited;
    }
    await Promise.allSettled([this.#stdoutTask, this.#stderrTask]);
  }

  async #request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timeout });
    });

    try {
      await this.#write({ method, id, params });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        pending.reject(error);
      }
    }
    return await response;
  }

  async #notify(method: string, params: JsonObject): Promise<void> {
    await this.#write({ method, params });
  }

  async #write(message: JsonObject): Promise<void> {
    if (this.#shuttingDown) throw new Error("Codex session is closing");
    await this.#writer.write(
      this.#encoder.encode(`${JSON.stringify(message)}\n`),
    );
  }

  async #readStdout(): Promise<void> {
    const reader = this.#process.stdout.getReader();
    let buffered = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += this.#decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line.length > 0) this.#handleLine(line);
        }
      }
      buffered += this.#decoder.decode();
      if (buffered.trim().length > 0) this.#handleLine(buffered.trim());
    } finally {
      reader.releaseLock();
    }
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const object = asObjectOrNull(message);
    if (!object) return;

    if (typeof object.id === "number") {
      this.#handleResponse(object as unknown as RpcResponse);
      return;
    }
    if (typeof object.method === "string") {
      this.#handleNotification(object.method, asObjectOrNull(object.params));
    }
  }

  #handleResponse(response: RpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(response.id);
    if (response.error) {
      pending.reject(
        new Error(
          typeof response.error.message === "string"
            ? response.error.message
            : "Codex request failed",
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  #handleNotification(method: string, params: JsonObject | null): void {
    if (!params || this.#turnSink === null || this.#threadId === null) return;
    if (params.threadId !== this.#threadId) return;

    if (method === "turn/started") {
      const turn = asObjectOrNull(params.turn);
      if (turn && typeof turn.id === "string") {
        this.#activeTurnId = turn.id;
        this.#turnStarted = true;
        this.#turnStartedSignal?.resolve();
        this.#emitAccepted();
      }
      return;
    }

    if (method === "item/agentMessage/delta") {
      if (
        typeof params.turnId === "string" &&
        this.#activeTurnId !== null &&
        params.turnId === this.#activeTurnId &&
        typeof params.delta === "string"
      ) {
        this.#turnSink({ type: "delta", delta: params.delta });
      }
      return;
    }

    if (method === "turn/completed") {
      const turn = asObjectOrNull(params.turn);
      if (
        !turn ||
        typeof turn.id !== "string" ||
        this.#activeTurnId === null ||
        turn.id !== this.#activeTurnId
      ) return;

      const status = turn.status;
      if (
        status !== "completed" &&
        status !== "interrupted" &&
        status !== "failed"
      ) return;
      const error = asObjectOrNull(turn.error);
      const message = typeof error?.message === "string"
        ? safeMessage(error.message)
        : undefined;
      const unauthorized = status === "failed" &&
        JSON.stringify(error?.codexErrorInfo ?? "").includes("unauthorized");
      this.#turnSink({
        type: "terminal",
        status,
        message: unauthorized
          ? "Codex authentication is unavailable or expired."
          : message,
        action: unauthorized
          ? "Run `codex login` outside Vantage, then retry the session."
          : status === "failed"
          ? "Check Codex outside Vantage, then try another prompt."
          : undefined,
        canContinue: true,
        nativeTruth: true,
      });
      this.#turnSink = null;
      this.#activeTurnId = null;
      this.#turnStartedSignal?.resolve();
      this.#turnStartedSignal = null;
      this.#turnStarted = false;
      this.#accepted = false;
    }
  }

  #emitAccepted(): void {
    if (!this.#accepted && this.#turnSink && this.#activeTurnId) {
      this.#accepted = true;
      this.#turnSink({
        type: "accepted",
        nativeTurnId: this.#activeTurnId,
      });
    }
  }

  async #watchExit(): Promise<void> {
    await this.#process.status.catch(() => undefined);
    if (this.#shuttingDown) return;
    const error = new Error("Codex app-server exited");
    this.#rejectPending(error);
    if (this.#turnSink) {
      this.#turnSink({
        type: "terminal",
        status: "failed",
        message: "Codex stopped before the turn completed.",
        action: "Check Codex outside Vantage, then retry the session.",
        canContinue: false,
        nativeTruth: false,
      });
      this.#turnSink = null;
      this.#activeTurnId = null;
      this.#turnStartedSignal?.resolve();
      this.#turnStartedSignal = null;
      this.#turnStarted = false;
      this.#accepted = false;
    }
  }

  #rejectPending(reason: unknown): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.#pending.clear();
  }
}

export function createCodexSession(repository: string): CodexSession {
  return new AppServerCodexSession(repository);
}

function spawnCodex(repository: string): ManagedChild {
  return new Deno.Command(resolveCodexExecutable(), {
    args: ["app-server"],
    cwd: repository,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

export function resolveCodexExecutable(): string {
  const override = Deno.env.get("VANTAGE_CODEX_PATH");
  if (override && isExecutableFile(override)) return override;

  const candidates: string[] = [];
  for (const directory of (Deno.env.get("PATH") ?? "").split(":")) {
    if (directory.length > 0) candidates.push(`${directory}/codex`);
  }
  candidates.push("/opt/homebrew/bin/codex", "/usr/local/bin/codex");

  const userDirectory = Deno.env.get("HOME");
  if (userDirectory) {
    candidates.push(
      `${userDirectory}/.local/bin/codex`,
      `${userDirectory}/.deno/bin/codex`,
    );
  }

  return candidates.find(isExecutableFile) ?? "codex";
}

function isExecutableFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function asObject(value: unknown): JsonObject {
  const object = asObjectOrNull(value);
  if (!object) throw new Error("Expected an object");
  return object;
}

function asObjectOrNull(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function safeMessage(message: string): string {
  const compact = message.replaceAll(/\s+/g, " ").trim();
  return compact.slice(0, 300);
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof Error &&
    /unauth|log.?in|401/i.test(error.message);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // Drain separately so app-server diagnostics cannot block stdout.
    }
  } finally {
    reader.releaseLock();
  }
}

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
}
