import type { CompatibilityManifest } from "./config.ts";
import type { JsonlClient } from "./jsonl_client.ts";
import type { ProcessCloseResult } from "./process_host.ts";
import { requireAuthenticatedAccount } from "./preflight.ts";
import {
  type ClassifiedEnvelope,
  LifecycleReducer,
  type LifecycleResult,
  type ProtocolRecord,
  TranscriptRecorder,
  validateLifecycleRecords,
} from "./transcript.ts";

export const OFFLINE_PROMPT =
  "Reply with one short sentence confirming the offline protocol lifecycle.";
export const AUTHENTICATED_PROMPT =
  "Reply with one short sentence confirming the pinned protocol compatibility check.";

export class LifecycleScenarioError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "LifecycleScenarioError";
  }
}

export type LifecycleClient =
  & Pick<
    JsonlClient,
    "request" | "notify" | "messages" | "close"
  >
  & { recorder: TranscriptRecorder };

export type LifecycleScenarioOptions = {
  compatibility: CompatibilityManifest;
  createClient: (repositoryPath: string) => Promise<LifecycleClient>;
  gitExecutable?: string;
  now?: () => number;
  prompt?: string;
};

export type LifecycleScenarioResult = LifecycleResult & {
  account: Record<string, unknown>;
  model: string;
  modelPages: number;
  initializeCount: 1;
  initializedCount: 1;
  repositoryPath: string;
  measurements: {
    spawnToInitializeResponse: number;
    initializeToReady: number;
    turnStartToFirstEvent: number;
    turnStartToCompleted: number;
  };
  processClose: ProcessCloseResult;
  transcript: readonly ProtocolRecord[];
};

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LifecycleScenarioError(
      "LIFECYCLE_RESPONSE_INVALID",
      `${context} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function asId(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LifecycleScenarioError(
      "LIFECYCLE_ID_INVALID",
      `${context} must be a non-empty string`,
    );
  }
  return value;
}

async function createTemporaryRepository(
  gitExecutable: string,
): Promise<string> {
  const repositoryPath = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "vantage-protocol-spike-",
  });
  try {
    const initialized = await new Deno.Command(gitExecutable, {
      args: ["init", "--quiet"],
      cwd: repositoryPath,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!initialized.success) {
      throw new LifecycleScenarioError(
        "GIT_INIT_FAILED",
        "git init failed in the disposable scenario repository",
        { exitCode: initialized.code },
      );
    }
    const verified = await new Deno.Command(gitExecutable, {
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: repositoryPath,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = new TextDecoder().decode(verified.stdout).trim();
    if (!verified.success || output !== "true") {
      throw new LifecycleScenarioError(
        "GIT_REPOSITORY_INVALID",
        "the disposable directory did not verify as a Git work tree",
        { exitCode: verified.code, output },
      );
    }
    return repositoryPath;
  } catch (error) {
    await Deno.remove(repositoryPath, { recursive: true });
    throw error;
  }
}

function requireClientRecord(
  recorder: TranscriptRecorder,
  method: string,
): Extract<ProtocolRecord, { direction: "client" }> {
  const record = recorder.records.find((candidate) =>
    candidate.direction === "client" && candidate.method === method
  );
  if (record?.direction !== "client") {
    throw new LifecycleScenarioError(
      "MEASUREMENT_RECORD_MISSING",
      `the ${method} client record is required for live measurements`,
    );
  }
  return record;
}

function requireResponseRecord(
  recorder: TranscriptRecorder,
  requestId: string | number | undefined,
  method: string,
): Extract<ProtocolRecord, { direction: "server" }> {
  const record = recorder.records.find((candidate) =>
    candidate.direction === "server" &&
    candidate.envelope?.kind === "response" &&
    candidate.envelope.id === requestId
  );
  if (record?.direction !== "server") {
    throw new LifecycleScenarioError(
      "MEASUREMENT_RECORD_MISSING",
      `the ${method} response record is required for live measurements`,
    );
  }
  return record;
}

function nonNegativeMeasurement(
  name: string,
  startedAt: number,
  completedAt: number,
): number {
  const value = completedAt - startedAt;
  if (!Number.isFinite(value) || value < 0) {
    throw new LifecycleScenarioError(
      "MEASUREMENT_INVALID",
      `${name} must be a non-negative monotonic observation`,
      { name },
    );
  }
  return value;
}

async function nextMessageWithin(
  iterator: AsyncIterator<
    Extract<
      ClassifiedEnvelope,
      { kind: "server-notification" | "server-request" }
    >
  >,
  timeoutMs: number,
  code: string,
): Promise<
  IteratorResult<
    Extract<
      ClassifiedEnvelope,
      { kind: "server-notification" | "server-request" }
    >
  >
> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new LifecycleScenarioError(
              code,
              "the live lifecycle exceeded a manifest safety timeout",
              { timeoutMs },
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function listVisibleModels(
  client: LifecycleClient,
  compatibility: CompatibilityManifest,
  now: () => number,
): Promise<{ model: string; pages: number }> {
  const startedAt = now();
  const seenCursors = new Set<string>();
  const models: Record<string, unknown>[] = [];
  let cursor: string | null | undefined;
  let pages = 0;
  const requireWithinDeadline = () => {
    if (now() - startedAt >= compatibility.limits.modelCatalogMs) {
      throw new LifecycleScenarioError(
        "MODEL_CATALOG_DEADLINE",
        "model catalog enumeration exceeded the manifest deadline",
        { pages, deadlineMs: compatibility.limits.modelCatalogMs },
      );
    }
  };
  while (true) {
    requireWithinDeadline();
    if (pages >= compatibility.limits.maxModelPages) {
      throw new LifecycleScenarioError(
        "MODEL_PAGE_EXHAUSTED",
        "model catalog exceeded the manifest page bound",
        { pages, maxPages: compatibility.limits.maxModelPages },
      );
    }
    const result = asObject(
      await client.request(
        "model/list",
        cursor === undefined ? {} : { cursor },
      ),
      "model/list response",
    );
    pages++;
    requireWithinDeadline();
    if (!Array.isArray(result.data)) {
      throw new LifecycleScenarioError(
        "MODEL_CATALOG_INVALID",
        "model/list response data must be an array",
      );
    }
    for (const model of result.data) {
      models.push(asObject(model, "model/list data entry"));
    }
    const nextCursor = result.nextCursor;
    if (nextCursor === null || nextCursor === undefined) break;
    if (typeof nextCursor !== "string" || nextCursor.length === 0) {
      throw new LifecycleScenarioError(
        "MODEL_CURSOR_INVALID",
        "model/list nextCursor must be absent, null, or a non-empty string",
      );
    }
    if (seenCursors.has(nextCursor)) {
      throw new LifecycleScenarioError(
        "MODEL_CURSOR_REPEATED",
        "model/list repeated a non-null cursor",
        { cursor: nextCursor, pages },
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  const selected = models.find((model) =>
    model.hidden === false && typeof model.model === "string" &&
    model.model.length > 0
  );
  if (selected === undefined) {
    throw new LifecycleScenarioError(
      "VISIBLE_MODEL_MISSING",
      "the completed catalog contains no visible model",
    );
  }
  return { model: selected.model as string, pages };
}

export async function runLifecycleScenario(
  options: LifecycleScenarioOptions,
): Promise<LifecycleScenarioResult> {
  const repositoryPath = await createTemporaryRepository(
    options.gitExecutable ?? "/usr/bin/git",
  );
  let client: LifecycleClient | undefined;
  let scenario:
    | Omit<LifecycleScenarioResult, "processClose">
    | undefined;
  let processClose: ProcessCloseResult | undefined;
  try {
    client = await options.createClient(repositoryPath);
    const initializeResult = await client.request("initialize", {
      clientInfo: {
        name: "vantage-protocol-spike",
        title: "Vantage protocol compatibility spike",
        version: "1",
      },
      capabilities: null,
    });
    asObject(initializeResult, "initialize response");
    const initializeRequest = requireClientRecord(
      client.recorder,
      "initialize",
    );
    const initializeResponse = requireResponseRecord(
      client.recorder,
      initializeRequest.id,
      "initialize",
    );
    await client.notify("initialized");
    const initialized = requireClientRecord(client.recorder, "initialized");

    const accountResult = await client.request("account/read", {});
    const account = requireAuthenticatedAccount(accountResult);
    const catalog = await listVisibleModels(
      client,
      options.compatibility,
      options.now ?? performance.now.bind(performance),
    );

    const threadResult = asObject(
      await client.request("thread/start", {
        model: catalog.model,
        cwd: repositoryPath,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
      }),
      "thread/start response",
    );
    const thread = asObject(
      threadResult.thread,
      "thread/start response.thread",
    );
    const threadId = asId(thread.id, "thread/start response.thread.id");

    const prompt = options.prompt ?? OFFLINE_PROMPT;
    const turnResult = asObject(
      await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      }),
      "turn/start response",
    );
    const turn = asObject(turnResult.turn, "turn/start response.turn");
    const turnId = asId(turn.id, "turn/start response.turn.id");
    const turnStart = requireClientRecord(client.recorder, "turn/start");

    const reducer = new LifecycleReducer();
    reducer.establishThread(threadId);
    reducer.establishTurn(threadId, turnId);
    let terminalSeen = false;
    let firstEventAt: number | undefined;
    let completedAt: number | undefined;
    const messageIterator = client.messages()[Symbol.asyncIterator]();
    const lifecycleNow = options.now ?? performance.now.bind(performance);
    const waitingStartedAt = lifecycleNow();
    const firstEventDeadline = waitingStartedAt +
      options.compatibility.limits.firstTurnEventMs;
    const turnDeadline = waitingStartedAt +
      options.compatibility.limits.turnCompletionMs;
    while (true) {
      const now = lifecycleNow();
      const completionRemaining = turnDeadline - now;
      if (completionRemaining <= 0) {
        throw new LifecycleScenarioError(
          "TURN_COMPLETION_DEADLINE",
          "the turn did not complete within the manifest safety timeout",
          { timeoutMs: options.compatibility.limits.turnCompletionMs },
        );
      }
      const timeoutMs = firstEventAt === undefined
        ? Math.min(
          firstEventDeadline - now,
          completionRemaining,
        )
        : completionRemaining;
      if (timeoutMs <= 0) {
        throw new LifecycleScenarioError(
          "FIRST_TURN_EVENT_DEADLINE",
          "the turn produced no event within the manifest safety timeout",
          { timeoutMs: options.compatibility.limits.firstTurnEventMs },
        );
      }
      const next = await nextMessageWithin(
        messageIterator,
        timeoutMs,
        firstEventAt === undefined
          ? "FIRST_TURN_EVENT_DEADLINE"
          : "TURN_COMPLETION_DEADLINE",
      );
      if (next.done) break;
      const envelope = next.value;
      if (envelope.kind !== "server-notification") {
        throw new LifecycleScenarioError(
          "SERVER_REQUEST_UNSUPPORTED",
          `lifecycle received unsupported server request ${envelope.method}`,
        );
      }
      const wireRecord = client.recorder.records.find((candidate) =>
        candidate.direction === "server" &&
        candidate.envelope === envelope
      );
      if (wireRecord?.direction !== "server") {
        throw new LifecycleScenarioError(
          "WIRE_RECORD_MISSING",
          "a delivered lifecycle event has no authoritative wire record",
        );
      }
      if (
        firstEventAt === undefined &&
        wireRecord.observationIndex > turnStart.observationIndex
      ) {
        firstEventAt = wireRecord.monotonicOffsetMs;
      }
      reducer.observeServerNotification(
        envelope.method,
        envelope.params,
        wireRecord.wireIndex,
      );
      if (envelope.method === "turn/completed") {
        completedAt = wireRecord.monotonicOffsetMs;
        terminalSeen = true;
        break;
      }
    }
    if (!terminalSeen) {
      throw new LifecycleScenarioError(
        "TURN_TERMINAL_MISSING",
        "server message stream ended before turn/completed",
      );
    }
    const liveResult = reducer.finish({ requireCompleted: true });
    const transcriptResult = validateLifecycleRecords(
      client.recorder.records,
      { threadId, turnId },
    );
    if (JSON.stringify(liveResult) !== JSON.stringify(transcriptResult)) {
      throw new LifecycleScenarioError(
        "LIFECYCLE_REPLAY_MISMATCH",
        "wire transcript replay disagreed with live lifecycle reduction",
      );
    }
    if (firstEventAt === undefined || completedAt === undefined) {
      throw new LifecycleScenarioError(
        "MEASUREMENT_RECORD_MISSING",
        "turn event measurements require first and completed notifications",
      );
    }
    scenario = {
      ...transcriptResult,
      account,
      model: catalog.model,
      modelPages: catalog.pages,
      initializeCount: 1,
      initializedCount: 1,
      repositoryPath,
      measurements: {
        spawnToInitializeResponse: initializeResponse.monotonicOffsetMs,
        initializeToReady: nonNegativeMeasurement(
          "initializeToReady",
          initializeResponse.monotonicOffsetMs,
          initialized.monotonicOffsetMs,
        ),
        turnStartToFirstEvent: nonNegativeMeasurement(
          "turnStartToFirstEvent",
          turnStart.monotonicOffsetMs,
          firstEventAt,
        ),
        turnStartToCompleted: nonNegativeMeasurement(
          "turnStartToCompleted",
          turnStart.monotonicOffsetMs,
          completedAt,
        ),
      },
      transcript: client.recorder.records,
    };
  } finally {
    try {
      if (client !== undefined) processClose = await client.close();
    } finally {
      await Deno.remove(repositoryPath, { recursive: true });
    }
  }
  if (scenario === undefined || processClose === undefined) {
    throw new LifecycleScenarioError(
      "LIFECYCLE_RESULT_MISSING",
      "the lifecycle ended without a complete result and process close",
    );
  }
  return { ...scenario, processClose };
}
