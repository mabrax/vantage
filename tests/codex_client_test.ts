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

Deno.test("Codex resolution finds the primary macOS installation outside a GUI PATH", () => {
  const originalPath = Deno.env.get("PATH");
  try {
    Deno.env.set("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    const executable = resolveCodexExecutable();
    if (
      Deno.build.os === "darwin" &&
      Deno.statSync("/opt/homebrew/bin/codex").isFile
    ) {
      assert.equal(executable, "/opt/homebrew/bin/codex");
    } else {
      assert.equal(executable, "codex");
    }
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
  }
});

Deno.test("native follow-ups reuse one thread and interruption waits for terminal truth", async () => {
  const process = new FakeAppServer();
  const session = new AppServerCodexSession("/repo", () => process);
  await session.initialize();

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
