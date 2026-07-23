import { loadConfiguration } from "../src/config.ts";
import {
  createTransportDiagnostic,
  type TransportError,
} from "../src/diagnostics.ts";
import { JsonlClient, type JsonlLimits } from "../src/jsonl_client.ts";
import { type ProcessHost, spawnProcessHost } from "../src/process_host.ts";
import { ProtocolValidator } from "../src/protocol_validation.ts";
import { type ProtocolRecord, TranscriptRecorder } from "../src/transcript.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "values differ",
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
}

async function assertRejectsCode(
  operation: Promise<unknown> | (() => Promise<unknown>),
  code: string,
): Promise<TransportError> {
  try {
    await (typeof operation === "function" ? operation() : operation);
  } catch (error) {
    assert(
      error instanceof Error && error.message.startsWith(`${code}:`),
      `expected ${code}, received ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return error as TransportError;
  }
  throw new Error(`expected ${code}`);
}

const configurationPromise = loadConfiguration();
const validatorPromise = configurationPromise.then((configuration) =>
  ProtocolValidator.load(`${configuration.generatedRoot}/json-schema`)
);

async function spawnClient(
  mode = "normal",
  modeValue = 0,
  overrides: Partial<JsonlLimits> = {},
): Promise<{ client: JsonlClient; recorder: TranscriptRecorder }> {
  const [configuration, validator] = await Promise.all([
    configurationPromise,
    validatorPromise,
  ]);
  const recorder = new TranscriptRecorder();
  const fixture =
    `${configuration.repositoryRoot}/spikes/codex-app-server/tests/fixtures/fake_app_server.ts`;
  const denoCommand = Deno.execPath().split("/").at(-1)!;
  const host = spawnProcessHost({
    executable: denoCommand,
    args: ["run", "--quiet", fixture, mode, String(modeValue)],
    cwd: configuration.repositoryRoot,
    env: {},
    maxStderrBytes: configuration.compatibility.limits.maxStderrBytes,
  });
  const limits: JsonlLimits = {
    maxStdoutLineBytes: configuration.compatibility.limits.maxStdoutLineBytes,
    maxQueueMessages: configuration.compatibility.limits.maxQueueMessages,
    maxQueueBytes: configuration.compatibility.limits.maxQueueBytes,
    requestTimeoutMs: configuration.compatibility.limits.initializeMs,
    ...overrides,
  };
  return {
    client: JsonlClient.connect({ host, validator, recorder, limits }),
    recorder,
  };
}

const initializeParams = {
  clientInfo: {
    name: "vantage-transport-test",
    version: "1",
  },
};

async function initialize(client: JsonlClient): Promise<void> {
  await client.request("initialize", initializeParams);
  await client.notify("initialized");
}

async function closeForTest(client: JsonlClient): Promise<void> {
  try {
    await client.close();
  } catch {
    // The test already asserts the retained transport failure. Cleanup must
    // still be attempted on that same client close boundary.
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function serverRecords(records: readonly ProtocolRecord[]) {
  return records.filter((record) => record.direction === "server");
}

Deno.test("real pipes preserve split frames, coalesced frames, and shared observation order", async () => {
  const { client, recorder } = await spawnClient("split-multiple");
  try {
    await initialize(client);
    const messages = client.messages()[Symbol.asyncIterator]();
    assertEquals((await messages.next()).value?.method, "skills/changed");
    assertEquals((await messages.next()).value?.method, "skills/changed");
    const records = recorder.records;
    assertEquals(
      records.map((record) => record.observationIndex),
      records.map((_, index) => index),
    );
    assertEquals(
      serverRecords(records).map((record) => record.wireIndex),
      [0, 1, 2],
    );
    assertEquals(
      records.map((record) => record.direction),
      ["client", "server", "client", "server", "server"],
    );
  } finally {
    await closeForTest(client);
  }
});

Deno.test("pending requests are registered before fast writes and concurrent writes stay serialized", async () => {
  const { client, recorder } = await spawnClient("delayed-read", 20);
  try {
    await initialize(client);
    const results = await Promise.all(
      Array.from(
        { length: 20 },
        () => client.request("account/read", {}),
      ),
    );
    assertEquals(results.length, 20);
    assertEquals(client.pendingRequestCount, 0);
    const accountWrites = recorder.records.filter((record) =>
      record.direction === "client" && record.method === "account/read"
    );
    assertEquals(
      accountWrites.map((record) =>
        record.direction === "client" ? record.id : undefined
      ),
      Array.from({ length: 20 }, (_, index) => index + 2),
    );
  } finally {
    await closeForTest(client);
  }
});

Deno.test("a queued valid write never runs after the preceding write fails validation", async () => {
  const { client, recorder } = await spawnClient();
  try {
    await initialize(client);
    const invalid = client.request("turn/start", {});
    const queuedValid = client.request("account/read", {});
    await assertRejectsCode(invalid, "SCHEMA_INVALID");
    await assertRejectsCode(queuedValid, "SCHEMA_INVALID");
    await assertRejectsCode(client.done, "SCHEMA_INVALID");
    assertEquals(client.pendingRequestCount, 0);
    assertEquals(
      recorder.records.filter((record) => record.direction === "client").map(
        (record) => record.direction === "client" ? record.method : undefined,
      ),
      ["initialize", "initialized"],
    );
  } finally {
    await closeForTest(client);
  }
});

Deno.test("interleaved notification arrival stays ordered independently of response correlation", async () => {
  const { client, recorder } = await spawnClient("interleaved");
  try {
    await initialize(client);
    const messages = client.messages()[Symbol.asyncIterator]();
    const result = await client.request("account/read", {});
    assertEquals(result, {
      account: { type: "apiKey" },
      requiresOpenaiAuth: false,
    });
    assertEquals((await messages.next()).value?.method, "skills/changed");
    const inbound = serverRecords(recorder.records);
    assertEquals(
      inbound.slice(-2).map((record) => record.envelope?.kind),
      ["server-notification", "response"],
    );
  } finally {
    await closeForTest(client);
  }
});

Deno.test("duplicate and unknown response IDs are typed and retained at their wire positions", async () => {
  for (
    const [mode, code] of [
      ["duplicate-id", "CORRELATION_DUPLICATE_ID"],
      ["unknown-id", "CORRELATION_UNKNOWN_ID"],
    ] as const
  ) {
    const { client, recorder } = await spawnClient(mode);
    try {
      await initialize(client);
      await assertRejectsCode(client.done, code);
      const failed = serverRecords(recorder.records).at(-1);
      assertEquals(failed?.diagnostic?.code, code);
      assert(failed?.wireIndex === 1, `${mode} failure lost its wire index`);
    } finally {
      await closeForTest(client);
    }
  }
});

Deno.test("initialization and closed-state write policy fail before bytes are exposed", async () => {
  const { client, recorder } = await spawnClient();
  await assertRejectsCode(
    client.request("account/read", {}),
    "INITIALIZATION_REQUIRED",
  );
  assertEquals(recorder.records.length, 0);
  await initialize(client);
  await assertRejectsCode(
    client.request("initialize", initializeParams),
    "INITIALIZE_DUPLICATE",
  );
  await client.close();
  await assertRejectsCode(
    client.request("account/read", {}),
    "CLIENT_CLOSED",
  );
  assertEquals(
    recorder.records.filter((record) =>
      record.direction === "client" && record.method === "initialize"
    ).length,
    1,
  );
});

Deno.test("outbound schema failures clear pending state and pre-initialize server methods fail after indexing", async () => {
  {
    const { client, recorder } = await spawnClient();
    try {
      await assertRejectsCode(
        client.request("initialize", {}),
        "SCHEMA_INVALID",
      );
      await assertRejectsCode(client.done, "SCHEMA_INVALID");
      assertEquals(client.pendingRequestCount, 0);
      assertEquals(recorder.records.length, 0);
    } finally {
      await closeForTest(client);
    }
  }
  {
    const { client, recorder } = await spawnClient("preinit-notification");
    try {
      await assertRejectsCode(
        client.request("initialize", initializeParams),
        "INITIALIZATION_REQUIRED",
      );
      await assertRejectsCode(client.done, "INITIALIZATION_REQUIRED");
      const failed = serverRecords(recorder.records)[0];
      assertEquals(failed?.wireIndex, 0);
      assertEquals(failed?.diagnostic?.code, "INITIALIZATION_REQUIRED");
    } finally {
      await closeForTest(client);
    }
  }
});

Deno.test("strict UTF-8, JSON, and single-value framing failures retain complete frames", async () => {
  for (
    const [mode, code] of [
      ["malformed-utf8", "UTF8_INVALID"],
      ["malformed-json", "JSON_INVALID"],
      ["multiple-json-values", "JSON_INVALID"],
    ] as const
  ) {
    const { client, recorder } = await spawnClient(mode);
    try {
      await initialize(client);
      await assertRejectsCode(client.done, code);
      const failed = serverRecords(recorder.records).at(-1);
      assertEquals(failed?.diagnostic?.code, code);
      assert(failed?.byteLength && failed.byteLength > 0);
    } finally {
      await closeForTest(client);
    }
  }
});

Deno.test("oversized complete lines and incomplete EOF fail without splitting or accepting a frame", async () => {
  {
    const { client, recorder } = await spawnClient(
      "oversized-line",
      600,
      { maxStdoutLineBytes: 256 },
    );
    try {
      await initialize(client);
      await assertRejectsCode(client.done, "FRAME_TOO_LARGE");
      const failed = serverRecords(recorder.records).at(-1);
      assertEquals(failed?.diagnostic?.code, "FRAME_TOO_LARGE");
      assert((failed?.byteLength ?? 0) > 256);
    } finally {
      await closeForTest(client);
    }
  }
  {
    const { client, recorder } = await spawnClient(
      "oversized-partial",
      600,
      { maxStdoutLineBytes: 256 },
    );
    try {
      await initialize(client);
      const failure = await assertRejectsCode(
        client.done,
        "FRAME_TOO_LARGE",
      );
      assertEquals(failure.diagnostic.observed, { incompleteBytes: 600 });
      assertEquals(serverRecords(recorder.records).length, 1);
    } finally {
      await closeForTest(client);
    }
  }
  {
    const { client, recorder } = await spawnClient("incomplete-line");
    try {
      await initialize(client);
      await assertRejectsCode(client.done, "INCOMPLETE_FRAME");
      assertEquals(serverRecords(recorder.records).length, 1);
    } finally {
      await closeForTest(client);
    }
  }
});

Deno.test("close failure settles a pending message waiter", async () => {
  const [configuration, validator] = await Promise.all([
    configurationPromise,
    validatorPromise,
  ]);
  let stdoutController:
    | ReadableStreamDefaultController<Uint8Array>
    | undefined;
  const host: ProcessHost = {
    pid: 1,
    stdin: new WritableStream<Uint8Array>({
      close() {
        throw new Error("injected close failure");
      },
    }),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    status: Promise.resolve({ success: false, code: 1, signal: null }),
    stderrCapture: Promise.resolve({
      totalBytes: 0,
      retainedByteCount: 0,
      retainedText: "",
    }),
    close() {
      return Promise.reject(new Error("injected host close failure"));
    },
  };
  const client = JsonlClient.connect({
    host,
    validator,
    recorder: new TranscriptRecorder(),
    limits: {
      maxStdoutLineBytes: configuration.compatibility.limits.maxStdoutLineBytes,
      maxQueueMessages: configuration.compatibility.limits.maxQueueMessages,
      maxQueueBytes: configuration.compatibility.limits.maxQueueBytes,
      requestTimeoutMs: configuration.compatibility.limits.initializeMs,
    },
  });
  const waiting = client.messages()[Symbol.asyncIterator]().next();
  await assertRejectsCode(client.close(), "CLOSE_FAILED");
  await assertRejectsCode(waiting, "CLOSE_FAILED");
  stdoutController?.close();
});

Deno.test("early EOF and EOF with pending requests use distinct typed failures", async () => {
  {
    const { client } = await spawnClient("early-eof");
    try {
      await initialize(client);
      await assertRejectsCode(client.done, "PROCESS_EXITED");
    } finally {
      await closeForTest(client);
    }
  }
  {
    const { client } = await spawnClient("pending-eof");
    try {
      await initialize(client);
      const request = client.request("account/read", {});
      await assertRejectsCode(request, "EOF_WITH_PENDING");
      await assertRejectsCode(client.done, "EOF_WITH_PENDING");
    } finally {
      await closeForTest(client);
    }
  }
});

Deno.test("request deadlines reject and remove the pending entry before cleanup", async () => {
  const { client } = await spawnClient("no-response", 0, {
    requestTimeoutMs: 25,
  });
  try {
    await initialize(client);
    await assertRejectsCode(
      client.request("account/read", {}),
      "REQUEST_TIMEOUT",
    );
    assertEquals(client.pendingRequestCount, 0);
    await assertRejectsCode(client.done, "REQUEST_TIMEOUT");
  } finally {
    await closeForTest(client);
  }
});

Deno.test("queue count and retained-byte exact boundaries pass", async () => {
  const notificationBytes = new TextEncoder().encode(
    JSON.stringify({ method: "skills/changed", params: {} }),
  ).byteLength;
  for (
    const limits of [
      { maxQueueMessages: 2, maxQueueBytes: 1_000_000 },
      { maxQueueMessages: 100, maxQueueBytes: notificationBytes * 2 },
      { maxQueueMessages: 2, maxQueueBytes: notificationBytes * 2 },
    ]
  ) {
    const { client, recorder } = await spawnClient(
      "queue-pressure",
      2,
      limits,
    );
    try {
      await initialize(client);
      await waitFor(
        () => serverRecords(recorder.records).length === 3,
        "queue boundary frames were not observed",
      );
      assertEquals(client.queueDepth, {
        messages: 2,
        bytes: notificationBytes * 2,
      });
      assertEquals(client.failure, undefined);
    } finally {
      await closeForTest(client);
    }
  }
});

Deno.test("first queue count or byte overflow fails without losing the complete frame", async () => {
  const notificationBytes = new TextEncoder().encode(
    JSON.stringify({ method: "skills/changed", params: {} }),
  ).byteLength;
  for (
    const limits of [
      { maxQueueMessages: 2, maxQueueBytes: 1_000_000, count: 3 },
      {
        maxQueueMessages: 100,
        maxQueueBytes: notificationBytes * 2 - 1,
        count: 2,
      },
      {
        maxQueueMessages: 2,
        maxQueueBytes: notificationBytes * 2,
        count: 3,
      },
    ]
  ) {
    const { client, recorder } = await spawnClient(
      "queue-pressure",
      limits.count,
      limits,
    );
    try {
      await initialize(client);
      const failure = await assertRejectsCode(client.done, "QUEUE_OVERFLOW");
      assertEquals(failure.diagnostic.observed, {
        messages: limits.count,
        bytes: notificationBytes * limits.count,
      });
      const inbound = serverRecords(recorder.records);
      assertEquals(inbound.length, limits.count + 1);
      assertEquals(inbound.at(-1)?.diagnostic?.code, "QUEUE_OVERFLOW");
      assertEquals(
        inbound.map((record) => record.wireIndex),
        Array.from({ length: inbound.length }, (_, index) => index),
      );
    } finally {
      await closeForTest(client);
    }
  }
});

Deno.test("large stderr is independently drained, tail-bounded, and absent from protocol records", async () => {
  const stderrBytes = 4 * 1024 * 1024;
  const { client, recorder } = await spawnClient(
    "stderr-flood",
    stderrBytes,
  );
  await initialize(client);
  const response = await client.request("account/read", {});
  assertEquals(response, {
    account: { type: "apiKey" },
    requiresOpenaiAuth: false,
  });
  const closed = await client.close();
  const configuration = await configurationPromise;
  assertEquals(closed.stderr.totalBytes, stderrBytes);
  assertEquals(
    closed.stderr.retainedByteCount,
    configuration.compatibility.limits.maxStderrBytes,
  );
  assert(
    recorder.records.every((record) =>
      record.direction === "client" ||
      record.envelope !== undefined ||
      record.diagnostic !== undefined
    ),
    "stderr must not create protocol records",
  );
});

Deno.test("unknown exact-version methods are indexed before failure and unknown requests receive method-not-found", async () => {
  for (
    const [mode, code] of [
      ["unknown-notification", "UNKNOWN_METHOD"],
      ["unknown-server-request", "UNKNOWN_SERVER_REQUEST"],
    ] as const
  ) {
    const { client, recorder } = await spawnClient(mode);
    try {
      await initialize(client);
      await assertRejectsCode(client.done, code);
      const failed = serverRecords(recorder.records).at(-1);
      assertEquals(failed?.diagnostic?.code, code);
      assert(failed?.envelope, "classified unknown envelope was not retained");
      if (mode === "unknown-server-request") {
        assert(
          recorder.records.some((record) =>
            record.direction === "client" &&
            record.method === "<server-request-response>" &&
            (record.params as { error?: { code?: number } }).error?.code ===
              -32601
          ),
          "unknown server request did not receive generated method-not-found shape",
        );
      }
    } finally {
      await closeForTest(client);
    }
  }
});

Deno.test("retained diagnostics redact credential-like context and direct personal paths", () => {
  const diagnostic = createTransportDiagnostic({
    code: "PROCESS_SPAWN_FAILED",
    stage: "test",
    observed: {
      authorization: "Bearer raw-secret",
      nested: {
        repository: "/Users/tester/Projects/private-repository",
        apiKey: "raw-api-key",
      },
    },
    stderr:
      "failure under /Users/tester/Projects/private-repository with selected-secret",
    sensitiveValues: ["selected-secret"],
    nextAction: "inspect /Users/tester/Projects/private-repository",
  });
  const serialized = JSON.stringify(diagnostic);
  assert(!serialized.includes("raw-secret"));
  assert(!serialized.includes("raw-api-key"));
  assert(!serialized.includes("selected-secret"));
  assert(!serialized.includes("/Users/tester"));
  assert(serialized.includes("[REDACTED]"));
  assert(serialized.includes("<redacted-path>"));
});
