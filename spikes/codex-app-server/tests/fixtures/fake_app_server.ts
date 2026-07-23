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
      await writeJson({ id: envelope.id, result: accountResult });
      continue;
    }
  }
  await stderrTask;
}

await main();
