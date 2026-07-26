import assert from "node:assert/strict";
import {
  AppServerCodexSession,
  type ManagedChild,
  resolveCodexExecutable,
} from "../src/codex_client.ts";
import { VantageError } from "../src/errors.ts";

type Request = {
  id: number;
  method: string;
  params: Record<string, unknown>;
};

class FakeAppServer implements ManagedChild {
  readonly pid = 4242;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  readonly requests: Request[] = [];
  readonly killSignals: Deno.Signal[] = [];
  deferTurnStarted = false;
  resumeError: string | null = null;
  resumeThreadIdOverride: string | null = null;
  resumeCwd = "/repo";
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  readonly #status = Promise.withResolvers<Deno.CommandStatus>();
  #stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  #buffer = "";
  #turn = 0;
  #closed = false;

  constructor() {
    this.status = this.#status.promise;
    this.stdout = new ReadableStream({
      start: (controller) => {
        this.#stdoutController = controller;
      },
    });
    this.stderr = new ReadableStream({
      start: (controller) => controller.close(),
    });
    this.stdin = new WritableStream({
      write: (chunk) => {
        this.#buffer += this.#decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = this.#buffer.indexOf("\n")) >= 0) {
          const line = this.#buffer.slice(0, newline);
          this.#buffer = this.#buffer.slice(newline + 1);
          if (line.length > 0) this.#handle(JSON.parse(line));
        }
      },
    });
  }

  kill(signal: Deno.Signal = "SIGTERM"): void {
    if (this.#closed) return;
    this.killSignals.push(signal);
    this.#closed = true;
    this.#stdoutController.close();
    this.#status.resolve({ success: true, code: 0, signal });
  }

  delta(turnId: string, delta: string): void {
    this.#send({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId, delta },
    });
  }

  start(turnId: string): void {
    this.#send({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: turnId, status: "inProgress" },
      },
    });
  }

  finish(turnId: string, status: "completed" | "interrupted" | "failed"): void {
    this.#send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: turnId, status },
      },
    });
  }

  #handle(message: Request): void {
    if (typeof message.id !== "number") return;
    this.requests.push(message);
    if (message.method === "initialize") {
      this.#respond(message.id, {});
    } else if (message.method === "account/read") {
      this.#respond(message.id, {
        account: { type: "chatgpt" },
        requiresOpenaiAuth: true,
      });
    } else if (message.method === "thread/start") {
      this.#respond(message.id, {
        thread: { id: "thread-1" },
        cwd: "/repo",
      });
    } else if (message.method === "thread/resume") {
      if (this.resumeError) {
        this.#send({
          id: message.id,
          error: { code: -32000, message: this.resumeError },
        });
      } else {
        this.#respond(message.id, {
          thread: {
            id: this.resumeThreadIdOverride ??
              String(message.params.threadId),
          },
          cwd: this.resumeCwd,
        });
      }
    } else if (message.method === "turn/start") {
      const turnId = `turn-${++this.#turn}`;
      this.#respond(message.id, { turn: { id: turnId } });
      if (!this.deferTurnStarted) this.start(turnId);
    } else if (message.method === "turn/interrupt") {
      this.#respond(message.id, {});
    }
  }

  #respond(id: number, result: unknown): void {
    this.#send({ id, result });
  }

  #send(message: unknown): void {
    this.#stdoutController.enqueue(
      this.#encoder.encode(`${JSON.stringify(message)}\n`),
    );
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for fake app-server event");
}

Deno.test("a missing Codex executable is classified as actionable", () => {
  assert.throws(
    () =>
      new AppServerCodexSession("/repo", () => {
        throw new Deno.errors.NotFound("missing");
      }),
    (error) =>
      error instanceof VantageError &&
      error.code === "codex_missing" &&
      error.action.includes("PATH"),
  );
});

Deno.test("Codex resolution uses PATH without requiring a fixed macOS installation", async () => {
  const originalPath = Deno.env.get("PATH");
  const directory = await Deno.makeTempDir({
    prefix: "vantage-codex-resolution-",
  });
  const executable = `${directory}/codex`;
  try {
    await Deno.writeTextFile(executable, "#!/bin/sh\nexit 0\n");
    Deno.env.set("PATH", directory);
    assert.equal(resolveCodexExecutable(), executable);
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native follow-ups reuse one thread and interruption waits for terminal truth", async () => {
  const process = new FakeAppServer();
  const session = new AppServerCodexSession("/repo", () => process);
  await session.initialize();
  await session.startDurableThread();

  const first: string[] = [];
  await session.startTurn("Remember amber", (event) => {
    first.push(event.type === "delta" ? `delta:${event.delta}` : event.type);
  });
  process.delta("turn-1", "Remembered.");
  process.finish("turn-1", "completed");
  await waitFor(() => first.includes("terminal"));

  const second: string[] = [];
  process.deferTurnStarted = true;
  await session.startTurn("Which word?", (event) => {
    second.push(event.type);
  });
  const interruption = session.interruptTurn();
  assert.equal(
    process.requests.some((request) => request.method === "turn/interrupt"),
    false,
  );
  process.start("turn-2");
  await interruption;

  const turnStarts = process.requests.filter((request) =>
    request.method === "turn/start"
  );
  assert.equal(turnStarts.length, 2);
  assert.equal(turnStarts[0].params.threadId, "thread-1");
  assert.equal(turnStarts[1].params.threadId, "thread-1");
  const interrupt = process.requests.find((request) =>
    request.method === "turn/interrupt"
  );
  assert.deepEqual(interrupt?.params, {
    threadId: "thread-1",
    turnId: "turn-2",
  });
  assert.deepEqual(second, ["accepted"]);

  process.finish("turn-2", "interrupted");
  await waitFor(() => second.includes("terminal"));
  assert.deepEqual(second, ["accepted", "terminal"]);

  await session.shutdown();
  assert.deepEqual(process.killSignals, ["SIGTERM"]);
});

Deno.test("unstarted initialization creates no thread while first submit seam is durable and exact resume uses only the saved ID", async () => {
  const firstProcess = new FakeAppServer();
  const first = new AppServerCodexSession("/repo", () => firstProcess);
  const initialized = await first.initialize();
  assert.deepEqual(initialized, { threadId: null, resumed: false });
  assert.equal(
    firstProcess.requests.some((request) =>
      request.method === "thread/start" || request.method === "thread/resume"
    ),
    false,
  );

  assert.equal(await first.startDurableThread(), "thread-1");
  const start = firstProcess.requests.find((request) =>
    request.method === "thread/start"
  );
  assert.equal(start?.params.ephemeral, false);
  assert.equal(start?.params.approvalPolicy, "never");
  assert.equal(start?.params.sandbox, "read-only");
  await first.shutdown();

  const secondProcess = new FakeAppServer();
  const second = new AppServerCodexSession("/repo", () => secondProcess);
  assert.deepEqual(
    await second.initialize({ nativeThreadId: "thread-1" }),
    { threadId: "thread-1", resumed: true },
  );
  assert.equal(
    secondProcess.requests.some((request) => request.method === "thread/start"),
    false,
  );
  const resume = secondProcess.requests.find((request) =>
    request.method === "thread/resume"
  );
  assert.deepEqual(resume?.params, {
    threadId: "thread-1",
    cwd: "/repo",
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  await second.shutdown();
});

Deno.test("missing native history fails explicitly without creating a replacement thread", async () => {
  const process = new FakeAppServer();
  process.resumeError = "thread not found";
  const session = new AppServerCodexSession("/repo", () => process);
  await assert.rejects(
    () => session.initialize({ nativeThreadId: "missing-thread" }),
    (error) =>
      error instanceof VantageError &&
      error.code === "native_missing" &&
      /read-only/i.test(error.action),
  );
  assert.equal(
    process.requests.some((request) => request.method === "thread/start"),
    false,
  );
  await session.shutdown();
});

Deno.test("changed native identity and incompatible repository history stay explicit and non-resumable", async () => {
  for (const mismatch of ["identity", "cwd"] as const) {
    const process = new FakeAppServer();
    if (mismatch === "identity") {
      process.resumeThreadIdOverride = "different-thread";
    } else {
      process.resumeCwd = "/different-repository";
    }
    const session = new AppServerCodexSession("/repo", () => process);
    await assert.rejects(
      () => session.initialize({ nativeThreadId: "thread-1" }),
      (error) =>
        error instanceof VantageError &&
        error.code === "native_incompatible",
    );
    assert.equal(
      process.requests.some((request) => request.method === "thread/start"),
      false,
    );
    await session.shutdown();
  }
});
