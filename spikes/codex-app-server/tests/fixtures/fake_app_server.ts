const mode = Deno.args[0] ?? "normal";
const modeValue = Number(Deno.args[1] ?? "0");
const encoder = new TextEncoder();

// Phase 4 owns these semantics. Reserving their names here prevents Phase 2
// scenarios from accidentally assigning weaker behavior to shutdown modes.
const PHASE_4_RESERVED_MODES = new Set([
  "ignore-stdin-close",
  "ignore-signals",
  "ordinary-grandchild",
  "surviving-grandchild",
  "immediate-session-escape",
]);
if (PHASE_4_RESERVED_MODES.has(mode)) {
  throw new Error(`fixture mode ${mode} is reserved for Phase 4`);
}

const initializeResult = {
  codexHome: "/tmp/fake-codex-home",
  platformFamily: "unix",
  platformOs: "macos",
  userAgent: "fake-app-server",
};
const accountResult = {
  account: { type: "apiKey" },
  requiresOpenaiAuth: false,
};
const changedNotification = {
  method: "skills/changed",
  params: {},
};
const lifecycleModel = {
  id: "offline-model-id",
  model: "offline-model",
  displayName: "Offline model",
  description: "Deterministic fake model",
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "medium",
  isDefault: true,
};

function lifecycleThread(cwd: unknown) {
  return {
    id: "thread-native-001",
    sessionId: "session-native-001",
    preview: "",
    ephemeral: true,
    modelProvider: "fake",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    cwd,
    cliVersion: "0.145.0",
    source: "appServer",
    turns: [],
  };
}

function lifecycleTurn(status: "inProgress" | "completed" | "failed") {
  return {
    id: "turn-native-001",
    items: [],
    status,
  };
}

function isLifecycleMode(selectedMode: string): boolean {
  return selectedMode === "full-lifecycle" ||
    selectedMode.startsWith("lifecycle-");
}

async function writeAll(
  writer: { write(data: Uint8Array): Promise<number> },
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await writer.write(bytes.subarray(offset));
  }
}

async function writeStdout(bytes: Uint8Array): Promise<void> {
  await writeAll(Deno.stdout, bytes);
}

async function writeJson(value: unknown): Promise<void> {
  await writeStdout(encoder.encode(`${JSON.stringify(value)}\n`));
}

async function* inputLines(): AsyncIterable<string> {
  const reader = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        yield buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered.length > 0) yield buffered;
  } finally {
    reader.releaseLock();
  }
}

async function emitAfterInitialized(selectedMode: string): Promise<boolean> {
  switch (selectedMode) {
    case "split-multiple": {
      const bytes = encoder.encode(
        `${JSON.stringify(changedNotification)}\n${
          JSON.stringify(changedNotification)
        }\n`,
      );
      await writeStdout(bytes);
      return false;
    }
    case "duplicate-id":
      await writeJson({ id: 1, result: initializeResult });
      return false;
    case "unknown-id":
      await writeJson({ id: 999_999, result: {} });
      return false;
    case "malformed-utf8":
      await writeStdout(new Uint8Array([0xc3, 0x28, 0x0a]));
      return false;
    case "malformed-json":
      await writeStdout(encoder.encode('{"method":}\n'));
      return false;
    case "multiple-json-values":
      await writeStdout(encoder.encode("{} {}\n"));
      return false;
    case "unknown-notification":
      await writeJson({ method: "future/notification", params: {} });
      return false;
    case "unknown-server-request":
      await writeJson({
        id: "server-1",
        method: "future/request",
        params: {},
      });
      return false;
    case "oversized-line": {
      const padding = "x".repeat(modeValue);
      await writeStdout(encoder.encode(`${JSON.stringify({ padding })}\n`));
      return false;
    }
    case "oversized-partial":
      await writeStdout(encoder.encode("x".repeat(modeValue)));
      return false;
    case "incomplete-line":
      await writeStdout(encoder.encode(JSON.stringify(changedNotification)));
      return true;
    case "early-eof":
      return true;
    case "queue-pressure":
      for (let index = 0; index < modeValue; index++) {
        await writeJson(changedNotification);
      }
      return false;
    default:
      return false;
  }
}

async function floodStderr(byteCount: number): Promise<void> {
  const chunk = new Uint8Array(64 * 1024).fill("e".charCodeAt(0));
  let remaining = byteCount;
  while (remaining > 0) {
    const length = Math.min(remaining, chunk.byteLength);
    await writeAll(Deno.stderr, chunk.subarray(0, length));
    remaining -= length;
  }
}

async function main(): Promise<void> {
  let stderrTask: Promise<void> | undefined;
  const delayedRequests: Record<string, unknown>[] = [];
  if (mode === "preinit-notification") {
    await writeJson(changedNotification);
  }
  for await (const line of inputLines()) {
    if (line.length === 0) continue;
    const envelope = JSON.parse(line) as Record<string, unknown>;
    if (envelope.method === "initialize") {
      const response = encoder.encode(
        `${JSON.stringify({ id: envelope.id, result: initializeResult })}\n`,
      );
      if (mode === "split-multiple") {
        const split = Math.max(1, Math.floor(response.byteLength / 2));
        await writeStdout(response.subarray(0, split));
        await writeStdout(response.subarray(split));
      } else {
        await writeStdout(response);
      }
      if (mode === "stderr-flood") {
        stderrTask = floodStderr(modeValue);
      }
      continue;
    }
    if (envelope.method === "initialized") {
      if (await emitAfterInitialized(mode)) break;
      continue;
    }
    if (envelope.method === "account/read") {
      if (mode === "pending-eof") break;
      if (mode === "no-response") continue;
      if (mode === "delayed-read") {
        delayedRequests.push(envelope);
        if (delayedRequests.length < modeValue) continue;
        for (const request of delayedRequests.splice(0)) {
          await writeJson({ id: request.id, result: accountResult });
        }
        continue;
      }
      if (mode === "interleaved") await writeJson(changedNotification);
      const selectedAccountResult = mode === "lifecycle-account-null"
        ? { account: null, requiresOpenaiAuth: true }
        : mode === "lifecycle-auth-flag"
        ? { account: { type: "apiKey" }, requiresOpenaiAuth: true }
        : accountResult;
      await writeJson({ id: envelope.id, result: selectedAccountResult });
      continue;
    }
    if (envelope.method === "model/list" && isLifecycleMode(mode)) {
      const params = envelope.params as Record<string, unknown> | undefined;
      const cursor = params?.cursor;
      if (mode === "lifecycle-cursor-absent") {
        await writeJson({
          id: envelope.id,
          result: { data: [lifecycleModel] },
        });
        continue;
      }
      if (mode === "lifecycle-repeated-cursor") {
        await writeJson({
          id: envelope.id,
          result: { data: [lifecycleModel], nextCursor: "repeat" },
        });
        continue;
      }
      if (mode === "lifecycle-endless-pages") {
        const page = typeof cursor === "string"
          ? Number(cursor.replace("page-", ""))
          : 0;
        await writeJson({
          id: envelope.id,
          result: {
            data: [lifecycleModel],
            nextCursor: `page-${page + 1}`,
          },
        });
        continue;
      }
      if (cursor === undefined) {
        await writeJson({
          id: envelope.id,
          result: {
            data: [lifecycleModel],
            nextCursor: mode === "lifecycle-cursor-null" ? null : "page-2",
          },
        });
      } else {
        await writeJson({
          id: envelope.id,
          result: { data: [lifecycleModel], nextCursor: null },
        });
      }
      continue;
    }
    if (envelope.method === "thread/start" && isLifecycleMode(mode)) {
      const params = envelope.params as Record<string, unknown>;
      const thread = lifecycleThread(params.cwd);
      await writeJson({
        id: envelope.id,
        result: {
          thread,
          model: "offline-model",
          modelProvider: "fake",
          cwd: params.cwd,
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly" },
        },
      });
      await writeJson({ method: "thread/started", params: { thread } });
      continue;
    }
    if (envelope.method === "turn/start" && isLifecycleMode(mode)) {
      const params = envelope.params as Record<string, unknown>;
      const threadId = params.threadId;
      const activeTurn = lifecycleTurn("inProgress");
      await writeJson({
        id: envelope.id,
        result: { turn: activeTurn },
      });
      await writeJson({
        method: "turn/started",
        params: { threadId, turn: activeTurn },
      });
      const startedItem = {
        type: "agentMessage",
        id: "item-native-001",
        text: "",
      };
      await writeJson({
        method: "item/started",
        params: {
          item: startedItem,
          threadId,
          turnId: activeTurn.id,
          startedAtMs: 1,
        },
      });
      const completedText = mode === "lifecycle-empty-agent"
        ? ""
        : "Offline lifecycle complete.";
      if (completedText.length > 0) {
        await writeJson({
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId: activeTurn.id,
            itemId: startedItem.id,
            delta: "Offline ",
          },
        });
        await writeJson({
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId: activeTurn.id,
            itemId: startedItem.id,
            delta: "lifecycle complete.",
          },
        });
      }
      const completedItem = { ...startedItem, text: completedText };
      await writeJson({
        method: "item/completed",
        params: {
          item: completedItem,
          threadId,
          turnId: activeTurn.id,
          completedAtMs: 2,
        },
      });
      const terminalStatus = mode === "lifecycle-failed-turn"
        ? "failed"
        : "completed";
      await writeJson({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            ...lifecycleTurn(terminalStatus),
            items: [completedItem],
          },
        },
      });
      continue;
    }
  }
  await stderrTask;
}

await main();
