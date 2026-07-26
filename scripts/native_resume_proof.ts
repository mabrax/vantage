interface JsonObject {
  [key: string]: unknown;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;
const SHUTDOWN_GRACE_MS = 2_000;
const repository = await Deno.realPath(Deno.args[0] ?? Deno.cwd());
const marker = `VANTAGE-${
  crypto.randomUUID().replaceAll("-", "").slice(0, 16)
}`;
let durableThreadId: string | null = null;
let firstProcessPid: number | null = null;
let secondProcessPid: number | null = null;
let archived = false;

class ProofAppServer {
  readonly pid: number;
  readonly #process: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  readonly #stdoutTask: Promise<void>;
  readonly #stderrTask: Promise<void>;
  readonly #notifications: JsonObject[] = [];
  #nextId = 1;
  #closed = false;
  #stderrTail = "";

  constructor(readonly cwd: string) {
    this.#process = new Deno.Command(resolveCodexExecutable(), {
      args: ["app-server"],
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.pid = this.#process.pid;
    this.#writer = this.#process.stdin.getWriter();
    this.#stdoutTask = this.#readStdout();
    this.#stderrTask = this.#readStderr();
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "vantage-native-resume-proof",
        title: "Vantage native resume proof",
        version: "0.1.0",
      },
    });
    await this.notify("initialized", {});
    const account = asObject(
      await this.request("account/read", { refreshToken: false }),
    );
    if (account.requiresOpenaiAuth === true && account.account === null) {
      throw new Error(
        "Codex is not authenticated; run `codex login` and retry.",
      );
    }
  }

  async startDurableThread(): Promise<string> {
    const result = asObject(
      await this.request("thread/start", {
        cwd: this.cwd,
        ephemeral: false,
        approvalPolicy: "never",
        sandbox: "read-only",
      }),
    );
    const thread = asObject(result.thread);
    if (typeof thread.id !== "string" || thread.id.length === 0) {
      throw new Error("thread/start did not return a native thread ID");
    }
    if (result.cwd !== this.cwd) {
      throw new Error("thread/start returned an unexpected working directory");
    }
    return thread.id;
  }

  async resumeThread(threadId: string): Promise<string> {
    const result = asObject(
      await this.request("thread/resume", {
        threadId,
        cwd: this.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
      }),
    );
    const thread = asObject(result.thread);
    if (typeof thread.id !== "string" || thread.id.length === 0) {
      throw new Error("thread/resume did not return a native thread ID");
    }
    return thread.id;
  }

  async runTurn(threadId: string, prompt: string): Promise<string> {
    const started = asObject(
      await this.request("turn/start", {
        threadId,
        cwd: this.cwd,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          networkAccess: false,
        },
        input: [{ type: "text", text: prompt }],
      }),
    );
    const turn = asObject(started.turn);
    if (typeof turn.id !== "string" || turn.id.length === 0) {
      throw new Error("turn/start did not return a turn ID");
    }
    const turnId = turn.id;
    let answer = "";
    const deadline = Date.now() + TURN_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const notification = await this.#nextNotification(
        Math.max(1, deadline - Date.now()),
      );
      if (notification.params === undefined) continue;
      const params = asObject(notification.params);
      if (params.threadId !== threadId) continue;
      if (
        notification.method === "item/agentMessage/delta" &&
        params.turnId === turnId &&
        typeof params.delta === "string"
      ) {
        answer += params.delta;
        continue;
      }
      if (notification.method !== "turn/completed") continue;
      const completedTurn = asObject(params.turn);
      if (completedTurn.id !== turnId) continue;
      if (completedTurn.status !== "completed") {
        throw new Error(
          `Native turn ${turnId} ended as ${String(completedTurn.status)}`,
        );
      }
      return answer;
    }
    throw new Error(`Native turn ${turnId} timed out`);
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request("thread/archive", { threadId });
  }

  async request(method: string, params: JsonObject): Promise<unknown> {
    if (this.#closed) throw new Error("app-server is closed");
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    await this.#write({ id, method, params });
    return await response;
  }

  async notify(method: string, params: JsonObject): Promise<void> {
    await this.#write({ method, params });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("app-server closed"));
    }
    this.#pending.clear();
    try {
      await this.#writer.close();
    } catch {
      // The child may already have closed stdin.
    }

    const exited = this.#process.status.then(() => true, () => true);
    try {
      this.#process.kill("SIGTERM");
    } catch {
      // The child already exited.
    }
    if (!(await settleWithin(exited, SHUTDOWN_GRACE_MS))) {
      try {
        this.#process.kill("SIGKILL");
      } catch {
        // The child exited between grace expiry and escalation.
      }
      await exited;
    }
    await Promise.allSettled([this.#stdoutTask, this.#stderrTask]);
  }

  async #write(message: JsonObject): Promise<void> {
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
    } finally {
      reader.releaseLock();
    }
  }

  async #readStderr(): Promise<void> {
    const reader = this.#process.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#stderrTail = (this.#stderrTail + decoder.decode(value, {
          stream: true,
        })).slice(-2_000);
      }
    } finally {
      reader.releaseLock();
    }
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = asObject(parsed);
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        const error = asObject(message.error);
        pending.reject(
          new Error(
            typeof error.message === "string"
              ? error.message
              : "app-server request failed",
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      this.#notifications.push(message);
    }
  }

  async #nextNotification(timeoutMs: number): Promise<JsonObject> {
    const deadline = Date.now() + timeoutMs;
    while (this.#notifications.length === 0) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for app-server notification${
            this.#stderrTail ? `; stderr tail: ${this.#stderrTail}` : ""
          }`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.#notifications.shift()!;
  }
}

let first: ProofAppServer | null = null;
let second: ProofAppServer | null = null;
try {
  first = new ProofAppServer(repository);
  firstProcessPid = first.pid;
  await first.initialize();
  durableThreadId = await first.startDurableThread();
  const firstAnswer = await first.runTurn(
    durableThreadId,
    `Remember this exact continuity marker for my next message: ${marker}. ` +
      "Reply with STORED only.",
  );
  if (!/\bSTORED\b/i.test(firstAnswer)) {
    throw new Error(`The first turn did not acknowledge the marker`);
  }
  await first.close();
  first = null;

  second = new ProofAppServer(repository);
  secondProcessPid = second.pid;
  await second.initialize();
  const resumedThreadId = await second.resumeThread(durableThreadId);
  if (resumedThreadId !== durableThreadId) {
    throw new Error(
      `Native thread ID changed across app-server replacement: ` +
        `${durableThreadId} -> ${resumedThreadId}`,
    );
  }
  const followUpAnswer = await second.runTurn(
    resumedThreadId,
    "What exact continuity marker did I ask you to remember in my immediately " +
      "preceding message? Reply with the marker only.",
  );
  if (!followUpAnswer.includes(marker)) {
    throw new Error(
      "The resumed native thread did not retain context from the first process",
    );
  }
  await second.archiveThread(durableThreadId);
  archived = true;

  console.log(JSON.stringify(
    {
      result: "passed",
      nativeThreadIdBefore: durableThreadId,
      nativeThreadIdAfter: resumedThreadId,
      firstAppServerPid: firstProcessPid,
      secondAppServerPid: secondProcessPid,
      contextMarkerMatched: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      cleanup: "native thread archived; both app-server processes reaped",
    },
    null,
    2,
  ));
} finally {
  await first?.close();
  if (durableThreadId !== null && !archived) {
    try {
      if (second === null) {
        second = new ProofAppServer(repository);
        await second.initialize();
      }
      await second.archiveThread(durableThreadId);
      archived = true;
    } catch {
      // Preserve the original proof failure; report cleanup state below.
    }
  }
  await second?.close();
  if (durableThreadId !== null && !archived) {
    console.error(
      JSON.stringify({
        cleanup: "failed",
        nativeThreadId: durableThreadId,
        action: "Archive this proof thread manually before retrying.",
      }),
    );
  }
}

function resolveCodexExecutable(): string {
  const override = Deno.env.get("VANTAGE_CODEX_PATH");
  if (override) return override;
  return Deno.build.os === "darwin" &&
      Deno.statSync("/opt/homebrew/bin/codex").isFile
    ? "/opt/homebrew/bin/codex"
    : "codex";
}

function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object from app-server");
  }
  return value as JsonObject;
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
