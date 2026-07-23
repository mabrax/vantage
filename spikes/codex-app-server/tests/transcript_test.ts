import {
  buildBaselineCoverage,
  deriveCoverageFromJournal,
  extractStableSurface,
  validateCoverageMembership,
} from "../src/coverage.ts";
import {
  type CoverageManifest,
  loadConfiguration,
  sha256Hex,
} from "../src/config.ts";
import {
  type LifecycleScenarioResult,
  OFFLINE_PROMPT,
  runLifecycleScenario,
} from "../src/lifecycle_scenario.ts";
import { JsonlClient } from "../src/jsonl_client.ts";
import { spawnProcessHost } from "../src/process_host.ts";
import {
  ProtocolValidator,
  validateJsonAgainstSchema,
} from "../src/protocol_validation.ts";
import {
  LifecycleReducer,
  type ProtocolRecord,
  redactAndValidateTranscript,
  redactProtocolValue,
  TranscriptRecorder,
  TranscriptValidationError,
  validateLifecycleRecords,
} from "../src/transcript.ts";

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
): Promise<Error> {
  try {
    await (typeof operation === "function" ? operation() : operation);
  } catch (error) {
    assert(
      error instanceof Error && error.message.startsWith(`${code}:`),
      `expected ${code}, received ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return error;
  }
  throw new Error(`expected ${code}`);
}

function assertThrowsCode(operation: () => unknown, code: string): Error {
  try {
    operation();
  } catch (error) {
    assert(
      error instanceof Error && error.message.startsWith(`${code}:`),
      `expected ${code}, received ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return error;
  }
  throw new Error(`expected ${code}`);
}

const configurationPromise = loadConfiguration();
const validatorPromise = configurationPromise.then((configuration) =>
  ProtocolValidator.load(`${configuration.generatedRoot}/json-schema`)
);
const evidenceSchemaPromise = configurationPromise.then((configuration) =>
  Deno.readTextFile(
    `${configuration.repositoryRoot}/spikes/codex-app-server/schemas/evidence.schema.json`,
  ).then(JSON.parse)
);

let scenarioPromise: Promise<LifecycleScenarioResult> | undefined;

async function fullScenario(): Promise<LifecycleScenarioResult> {
  if (scenarioPromise !== undefined) return await scenarioPromise;
  scenarioPromise = (async () => {
    const [configuration, validator] = await Promise.all([
      configurationPromise,
      validatorPromise,
    ]);
    return await runLifecycleScenario({
      compatibility: configuration.compatibility,
      createClient: () => {
        const recorder = new TranscriptRecorder();
        const host = spawnProcessHost({
          executable: Deno.execPath().split("/").at(-1)!,
          args: [
            "run",
            "--quiet",
            `${configuration.repositoryRoot}/spikes/codex-app-server/tests/fixtures/fake_app_server.ts`,
            "full-lifecycle",
          ],
          cwd: configuration.repositoryRoot,
          env: {},
          maxStderrBytes: configuration.compatibility.limits.maxStderrBytes,
        });
        return Promise.resolve(JsonlClient.connect({
          host,
          validator,
          recorder,
          limits: {
            maxStdoutLineBytes:
              configuration.compatibility.limits.maxStdoutLineBytes,
            maxQueueMessages:
              configuration.compatibility.limits.maxQueueMessages,
            maxQueueBytes: configuration.compatibility.limits.maxQueueBytes,
            requestTimeoutMs: configuration.compatibility.limits.initializeMs,
          },
        }));
      },
    });
  })();
  return await scenarioPromise;
}

function scenarioRepositoryPath(records: readonly ProtocolRecord[]): string {
  const record = records.find((candidate) =>
    candidate.direction === "client" && candidate.method === "thread/start"
  );
  assert(record?.direction === "client");
  const params = record.params as Record<string, unknown>;
  assert(typeof params.cwd === "string");
  return params.cwd;
}

function evidenceClientRecord(params: unknown): Record<string, unknown> {
  return {
    direction: "client",
    observationIndex: 0,
    monotonicOffsetMs: 0,
    method: "account/read",
    id: 1,
    params,
    byteLength: 1,
    schema: { id: "client-request:account/read", valid: true },
    nativeIds: {},
  };
}

function establishReducer(): LifecycleReducer {
  const reducer = new LifecycleReducer();
  reducer.establishThread("thread-native");
  reducer.establishTurn("thread-native", "turn-native");
  return reducer;
}

function itemStarted(
  reducer: LifecycleReducer,
  wireIndex: number,
  itemId = "item-native",
  text = "",
): void {
  reducer.observeServerNotification("item/started", {
    threadId: "thread-native",
    turnId: "turn-native",
    item: { type: "agentMessage", id: itemId, text },
    startedAtMs: 1,
  }, wireIndex);
}

function itemDelta(
  reducer: LifecycleReducer,
  wireIndex: number,
  delta: string,
  itemId = "item-native",
): void {
  reducer.observeServerNotification("item/agentMessage/delta", {
    threadId: "thread-native",
    turnId: "turn-native",
    itemId,
    delta,
  }, wireIndex);
}

function itemCompleted(
  reducer: LifecycleReducer,
  wireIndex: number,
  text: string,
  itemId = "item-native",
): void {
  reducer.observeServerNotification("item/completed", {
    threadId: "thread-native",
    turnId: "turn-native",
    item: { type: "agentMessage", id: itemId, text },
    completedAtMs: 2,
  }, wireIndex);
}

function turnCompleted(
  reducer: LifecycleReducer,
  wireIndex: number,
  status: "completed" | "failed" | "interrupted" = "completed",
): void {
  reducer.observeServerNotification("turn/completed", {
    threadId: "thread-native",
    turn: { id: "turn-native", items: [], status },
  }, wireIndex);
}

Deno.test("full fake-child lifecycle preserves distinct identities and complete item order", async () => {
  const result = await fullScenario();
  assertEquals(result.initializeCount, 1);
  assertEquals(result.initializedCount, 1);
  assertEquals(result.modelPages, 2);
  assertEquals(result.threadId, "thread-native-001");
  assertEquals(result.turnId, "turn-native-001");
  assertEquals(result.terminalStatus, "completed");
  assertEquals(result.completedItems, 1);
  assert(result.agentText.length > 0);
  const requestIds = result.transcript.flatMap((record) =>
    record.direction === "client" && record.id !== undefined ? [record.id] : []
  );
  assert(requestIds.every((id) => typeof id === "number"));
  assert(!requestIds.some((id) => String(id) === result.threadId));
  assert(!requestIds.some((id) => String(id) === result.turnId));
  assertEquals(
    result.transcript.map((record) => record.observationIndex),
    result.transcript.map((_, index) => index),
  );
  assertEquals(
    result.transcript.filter((record) => record.direction === "server").map(
      (record) => record.direction === "server" ? record.wireIndex : -1,
    ),
    result.transcript.filter((record) => record.direction === "server").map(
      (_, index) => index,
    ),
  );
});

Deno.test("lifecycle reducer reconstructs ordered deltas and rejects impossible transitions", async () => {
  {
    const reducer = establishReducer();
    itemStarted(reducer, 1);
    itemDelta(reducer, 2, "hello ");
    itemDelta(reducer, 3, "world");
    itemCompleted(reducer, 4, "hello world");
    turnCompleted(reducer, 5);
    assertEquals(
      reducer.finish({ requireCompleted: true }).agentText,
      "hello world",
    );
  }
  {
    const reducer = establishReducer();
    itemStarted(reducer, 1, "item-native", "seeded ");
    itemDelta(reducer, 2, "message");
    itemCompleted(reducer, 3, "seeded message");
    turnCompleted(reducer, 4);
    assertEquals(
      reducer.finish({ requireCompleted: true }).agentText,
      "seeded message",
    );
  }
  {
    const reducer = establishReducer();
    itemStarted(reducer, 1, "item-native", "already complete");
    itemCompleted(reducer, 2, "already complete");
    turnCompleted(reducer, 3);
    assertEquals(
      reducer.finish({ requireCompleted: true }).agentText,
      "already complete",
    );
  }
  {
    const reducer = establishReducer();
    assertThrowsCode(() => itemDelta(reducer, 1, "early"), "ITEM_NOT_STARTED");
  }
  {
    const reducer = establishReducer();
    itemStarted(reducer, 1);
    assertThrowsCode(() => itemStarted(reducer, 2), "ITEM_START_DUPLICATE");
  }
  {
    const reducer = establishReducer();
    itemStarted(reducer, 1, "item-native", "seeded ");
    itemDelta(reducer, 2, "text");
    const error = assertThrowsCode(
      () => itemCompleted(reducer, 3, "semantically different"),
      "AGENT_TEXT_MISMATCH",
    );
    assert(error instanceof TranscriptValidationError);
    assertEquals(error.details, {
      startedTextLength: 7,
      deltaCount: 1,
      deltaTextLength: 4,
      reconstructedTextLength: 11,
      completedTextLength: 22,
    });
    assert(!JSON.stringify(error.details).includes("seeded"));
    assert(!JSON.stringify(error.details).includes("semantically different"));
  }
  {
    const reducer = establishReducer();
    itemStarted(reducer, 1);
    itemCompleted(reducer, 2, "");
    assertThrowsCode(
      () => itemDelta(reducer, 3, "late"),
      "ITEM_ALREADY_COMPLETED",
    );
  }
  {
    const reducer = establishReducer();
    itemStarted(reducer, 1);
    assertThrowsCode(
      () => turnCompleted(reducer, 2),
      "ITEMS_INCOMPLETE_AT_TERMINAL",
    );
  }
  {
    const reducer = establishReducer();
    assertThrowsCode(
      () =>
        reducer.observeServerNotification("turn/completed", {
          threadId: "different-thread",
          turn: { id: "turn-native", items: [], status: "completed" },
        }, 1),
      "THREAD_ID_MISMATCH",
    );
  }
  await Promise.resolve();
});

Deno.test("non-completed turns and empty completed agent text fail compatibility", () => {
  {
    const reducer = establishReducer();
    itemStarted(reducer, 1);
    itemDelta(reducer, 2, "partial");
    itemCompleted(reducer, 3, "partial");
    turnCompleted(reducer, 4, "failed");
    assertThrowsCode(
      () => reducer.finish({ requireCompleted: true }),
      "TURN_NOT_COMPLETED",
    );
  }
  {
    const reducer = establishReducer();
    itemStarted(reducer, 1);
    itemCompleted(reducer, 2, "");
    turnCompleted(reducer, 3);
    assertThrowsCode(
      () => reducer.finish({ requireCompleted: true }),
      "AGENT_TEXT_EMPTY",
    );
  }
});

Deno.test("raw validation precedes deterministic schema-preserving redaction", async () => {
  const [result, validator, evidenceSchema, configuration] = await Promise.all([
    fullScenario(),
    validatorPromise,
    evidenceSchemaPromise,
    configurationPromise,
  ]);
  const temporaryRepository = scenarioRepositoryPath(result.transcript);
  const retained = await redactAndValidateTranscript(
    result.transcript,
    validator,
    evidenceSchema,
    {
      sensitivePaths: [temporaryRepository, configuration.repositoryRoot],
      rawTexts: [OFFLINE_PROMPT, result.agentText],
    },
  );
  assertEquals(retained.length, result.transcript.length);
  const serialized = JSON.stringify(retained);
  for (
    const sensitive of [
      temporaryRepository,
      configuration.repositoryRoot,
      OFFLINE_PROMPT,
      result.agentText,
    ]
  ) {
    assert(!serialized.includes(sensitive), `retained ${sensitive}`);
  }
  assert(!/(?:\/Users\/|\/home\/)/.test(serialized));
  assert(
    retained.every((record) =>
      record.schema.valid === true &&
      record.schema.id.length > 0
    ),
  );
  assertEquals(
    retained.map((record) => record.observationIndex),
    retained.map((_, index) => index),
  );
  const retainedLifecycle = validateLifecycleRecords(retained, {
    threadId: result.threadId,
    turnId: result.turnId,
  });
  assert(retainedLifecycle.agentText.length > 0);
});

Deno.test("segment-aware redaction preserves seeded agent-text reconstruction and rejects raw disagreement", async () => {
  const [result, validator, evidenceSchema, configuration] = await Promise.all([
    fullScenario(),
    validatorPromise,
    evidenceSchemaPromise,
    configurationPromise,
  ]);
  const records = structuredClone(result.transcript) as ProtocolRecord[];
  const notifications = records.flatMap((record) =>
    record.direction === "server" &&
      record.envelope?.kind === "server-notification"
      ? [record.envelope]
      : []
  );
  const started = notifications.find((envelope) =>
    envelope.method === "item/started"
  );
  const deltas = notifications.filter((envelope) =>
    envelope.method === "item/agentMessage/delta"
  );
  const completed = notifications.find((envelope) =>
    envelope.method === "item/completed"
  );
  assert(started !== undefined);
  assertEquals(deltas.length, 2);
  assert(completed !== undefined);
  const startedParams = started.params as Record<string, unknown>;
  const startedItem = startedParams.item as Record<string, unknown>;
  const firstDelta = deltas[0].params as Record<string, unknown>;
  const secondDelta = deltas[1].params as Record<string, unknown>;
  const completedParams = completed.params as Record<string, unknown>;
  const completedItem = completedParams.item as Record<string, unknown>;
  startedItem.text = "seeded ";
  firstDelta.delta = "agent ";
  secondDelta.delta = "message";
  completedItem.text = "seeded agent message";

  const rawLifecycle = validateLifecycleRecords(records, {
    threadId: result.threadId,
    turnId: result.turnId,
  });
  assertEquals(rawLifecycle.agentText, "seeded agent message");
  const retained = await redactAndValidateTranscript(
    records,
    validator,
    evidenceSchema,
    {
      sensitivePaths: [
        scenarioRepositoryPath(records),
        configuration.repositoryRoot,
      ],
      rawTexts: ["seeded ", "agent ", "message", "seeded agent message"],
    },
  );
  const retainedLifecycle = validateLifecycleRecords(retained, {
    threadId: result.threadId,
    turnId: result.turnId,
  });
  assert(retainedLifecycle.agentText.length > 0);
  const retainedText = retainedLifecycle.agentText;
  assert(retainedText.includes("[redacted-text-segment:sha256:"));
  assert(!retainedText.includes("seeded"));
  assert(!retainedText.includes("agent"));
  assert(!retainedText.includes("message"));
  const retainedAgain = await redactAndValidateTranscript(
    records,
    validator,
    evidenceSchema,
    {
      sensitivePaths: [
        scenarioRepositoryPath(records),
        configuration.repositoryRoot,
      ],
      rawTexts: ["seeded ", "agent ", "message", "seeded agent message"],
    },
  );
  assertEquals(retainedAgain, retained);

  const disagrees = structuredClone(records) as ProtocolRecord[];
  const disagreeingCompletion = disagrees.find((record) =>
    record.direction === "server" &&
    record.envelope?.kind === "server-notification" &&
    record.envelope.method === "item/completed"
  );
  assert(
    disagreeingCompletion?.direction === "server" &&
      disagreeingCompletion.envelope?.kind === "server-notification",
  );
  const disagreeingParams = disagreeingCompletion.envelope.params as Record<
    string,
    unknown
  >;
  (disagreeingParams.item as Record<string, unknown>).text =
    "semantically different";
  await assertRejectsCode(
    redactAndValidateTranscript(
      disagrees,
      validator,
      evidenceSchema,
    ),
    "AGENT_TEXT_MISMATCH",
  );
});

Deno.test("pre-redaction schema and ordering failures produce no retained result", async () => {
  const [result, validator, evidenceSchema] = await Promise.all([
    fullScenario(),
    validatorPromise,
    evidenceSchemaPromise,
  ]);
  const invalid = structuredClone(result.transcript) as ProtocolRecord[];
  const turnStart = invalid.find((record) =>
    record.direction === "client" && record.method === "turn/start"
  );
  assert(turnStart?.direction === "client");
  turnStart.params = {};
  await assertRejectsCode(
    redactAndValidateTranscript(invalid, validator, evidenceSchema),
    "PROTOCOL_SCHEMA_INVALID",
  );

  const reordered = structuredClone(result.transcript) as ProtocolRecord[];
  reordered[1].observationIndex = 99;
  await assertRejectsCode(
    redactAndValidateTranscript(reordered, validator, evidenceSchema),
    "OBSERVATION_ORDER_INVALID",
  );
});

Deno.test("sensitive fields reject while text, paths, and account IDs use deterministic same-type replacements", async () => {
  for (
    const field of [
      "previousAccessToken",
      "refresh_token",
      "bearerToken",
      "authenticationToken",
      "authToken",
      "id_token",
      "openaiApiKey",
      "token",
    ]
  ) {
    await assertRejectsCode(
      redactProtocolValue({ [field]: "credential" }),
      "CREDENTIAL_FIELD_REJECTED",
    );
  }
  const source = {
    previousEmail: "person@example.test",
    previousAccountId: "account-raw",
    chatgptAccountId: 42,
    creatorAccountUserId: "user-raw",
    previousCwd: "/Users/example/private/project",
    text: "private prompt",
    usesCodexManagedCredentials: true,
    isSecret: false,
    refreshToken: false,
  };
  const first = await redactProtocolValue(source);
  const second = await redactProtocolValue(source);
  assertEquals(first, second);
  const record = first as Record<string, unknown>;
  assert(typeof record.previousEmail === "string");
  assert(typeof record.previousAccountId === "string");
  assert(
    typeof record.chatgptAccountId === "number" &&
      record.chatgptAccountId < 0,
  );
  assert(typeof record.creatorAccountUserId === "string");
  assert(
    typeof record.previousCwd === "string" &&
      record.previousCwd.startsWith("/redacted/path/"),
  );
  assert(typeof record.text === "string");
  assertEquals(record.usesCodexManagedCredentials, true);
  assertEquals(record.isSecret, false);
  assertEquals(record.refreshToken, false);
  assert(!JSON.stringify(record).includes("person@example.test"));
  assert(!JSON.stringify(record).includes("account-raw"));
  assert(!JSON.stringify(record).includes("user-raw"));
  assert(!JSON.stringify(record).includes("private prompt"));
  assert(!JSON.stringify(record).includes("/Users/example"));
});

Deno.test("local evidence schema rejects credential fields and keeps shutdown gates independent", async () => {
  const evidenceSchema = await evidenceSchemaPromise;
  const safeParams = await redactProtocolValue({
    previousEmail: "person@example.test",
    previousAccountId: "account-raw",
    chatgptAccountId: 42,
    creatorAccountUserId: "user-raw",
    previousCwd: "/tmp/raw-repository",
    usesCodexManagedCredentials: true,
    isSecret: false,
  });
  validateJsonAgainstSchema(
    evidenceSchema,
    evidenceClientRecord(safeParams),
    "EVIDENCE_SCHEMA_INVALID",
  );
  for (
    const params of [
      { previousAccessToken: "secret" },
      { openaiApiKey: "secret" },
      { previousAccountId: "account-raw" },
      { chatgptAccountId: 42 },
      { chatgptAccountId: -42 },
      { creatorAccountUserId: "user-raw" },
      { previousEmail: "person@example.test" },
      { previousCwd: "/tmp/raw-repository" },
      { previousCwd: "/redacted/path/not-a-hash" },
    ]
  ) {
    assertThrowsCode(
      () =>
        validateJsonAgainstSchema(
          evidenceSchema,
          evidenceClientRecord(params),
          "EVIDENCE_SCHEMA_INVALID",
        ),
      "EVIDENCE_SCHEMA_INVALID",
    );
  }
  validateJsonAgainstSchema(
    evidenceSchema,
    evidenceClientRecord({
      usesCodexManagedCredentials: true,
      isSecret: false,
      refreshToken: false,
    }),
    "EVIDENCE_SCHEMA_INVALID",
  );

  const hash = "a".repeat(64);
  const summary = {
    schemaVersion: 1,
    runId: "offline-fixture",
    recordedAt: "2026-01-01T00:00:00.000Z",
    platform: { os: "darwin", arch: "aarch64" },
    versions: { deno: "2.9.3", codex: "0.145.0" },
    hashes: {
      compatibility: hash,
      generatedBundle: hash,
      coverage: hash,
      transcript: hash,
    },
    observationsMs: {
      spawnToInitializeResponse: 1,
      initializeToReady: 1,
      turnStartToFirstEvent: 1,
      turnStartToCompleted: 1,
      stdinCloseToExit: 1,
      totalShutdown: 1,
    },
    lifecycle: {
      stdoutLines: 1,
      stderrBytes: 0,
      threadId: "thread",
      turnId: "turn",
      terminalStatus: "completed",
      completedItems: 1,
    },
    shutdown: {
      rootIdentity: { rootPid: 101, processGroupId: 101, sessionId: 101 },
      observedPids: [101],
      lineageEvents: [],
      signalPath: ["stdin-close"],
      timedOutStages: [],
      directExit: { success: true, code: 0, signal: null },
      drains: { stdoutCompleted: true, stderrCompleted: true },
      timings: {
        startedAtMs: 1,
        stdinClosedAtMs: 2,
        directExitAtMs: 3,
        completedAtMs: 4,
        totalMs: 3,
      },
      remainingPids: [],
      noObservedDescendantsRemain: true,
      containmentCapability: {
        facility: "snapshot-only",
        available: false,
        armedBeforeChildExecution: false,
        continuouslyTracked: false,
        creationEventsCovered: false,
        sessionEscapeCovered: false,
        reparentingCovered: false,
        lossDetected: false,
        overflowed: false,
        unavailableReason: "race-closing tracker unavailable",
      },
      escapedDescendantContainmentProven: false,
      diagnostics: [],
    },
    gates: {
      exactVersions: true,
      generatedArtifactsMatch: true,
      coverageComplete: true,
      everyRetainedEnvelopeSchemaValid: true,
      lifecycleOrdered: true,
      authenticatedTurnCompleted: true,
      noObservedDescendantsRemain: true,
    },
  };
  validateJsonAgainstSchema(evidenceSchema, summary);
  const missingProof = structuredClone(summary) as Record<string, unknown>;
  delete (missingProof.shutdown as Record<string, unknown>)
    .escapedDescendantContainmentProven;
  assertThrowsCode(
    () =>
      validateJsonAgainstSchema(
        evidenceSchema,
        missingProof,
        "EVIDENCE_SCHEMA_INVALID",
      ),
    "EVIDENCE_SCHEMA_INVALID",
  );
  const observedLeak = structuredClone(summary) as Record<string, unknown>;
  const observedLeakShutdown = observedLeak.shutdown as Record<string, unknown>;
  observedLeakShutdown.remainingPids = [202];
  observedLeakShutdown.noObservedDescendantsRemain = false;
  assertThrowsCode(
    () =>
      validateJsonAgainstSchema(
        evidenceSchema,
        observedLeak,
        "EVIDENCE_SCHEMA_INVALID",
      ),
    "EVIDENCE_SCHEMA_INVALID",
  );
  const unsupportedProof = structuredClone(summary) as Record<string, unknown>;
  (unsupportedProof.shutdown as Record<string, unknown>)
    .escapedDescendantContainmentProven = true;
  assertThrowsCode(
    () =>
      validateJsonAgainstSchema(
        evidenceSchema,
        unsupportedProof,
        "EVIDENCE_SCHEMA_INVALID",
      ),
    "EVIDENCE_SCHEMA_INVALID",
  );
});

Deno.test("schema-valid server-request responses are correlated, retained, and excluded from outbound coverage", async () => {
  const [validator, evidenceSchema, configuration] = await Promise.all([
    validatorPromise,
    evidenceSchemaPromise,
    configurationPromise,
  ]);
  const recorder = new TranscriptRecorder();
  const request = recorder.appendServerFrame(1, 0);
  recorder.classifyServerFrame(request, {
    kind: "server-request",
    id: "server-request-1",
    method: "execCommandApproval",
    params: {
      conversationId: "thread-native",
      callId: "call-native",
      approvalId: null,
      command: ["true"],
      cwd: "/tmp/raw-repository",
      reason: null,
      parsedCmd: [],
    },
  });
  recorder.appendClientResponse(
    {
      id: "server-request-1",
      result: { decision: "approved" },
    },
    1,
    1,
  );

  const retained = await redactAndValidateTranscript(
    recorder.records,
    validator,
    evidenceSchema,
    { sensitivePaths: ["/tmp/raw-repository"] },
  );
  assertEquals(retained.length, 2);
  const response = retained[1];
  assert(response.direction === "client");
  assertEquals(response.method, "<server-request-response>");
  assertEquals(
    response.schema.id,
    "server-request-response:execCommandApproval",
  );
  assertEquals(response.params, { result: { decision: "approved" } });

  const surface = await extractStableSurface(
    `${configuration.generatedRoot}/json-schema`,
  );
  const baseline = buildBaselineCoverage(
    surface,
    configuration.generation.bundleSha256,
  );
  const responseOnly = deriveCoverageFromJournal(
    baseline,
    surface,
    [response],
  );
  assertEquals(responseOnly, baseline);
});

Deno.test("server-request response retention rejects unmatched and unanswered request IDs", async () => {
  const [validator, evidenceSchema] = await Promise.all([
    validatorPromise,
    evidenceSchemaPromise,
  ]);
  const unmatched = new TranscriptRecorder();
  unmatched.appendClientResponse(
    {
      id: "missing-server-request",
      result: { decision: "approved" },
    },
    1,
    0,
  );
  await assertRejectsCode(
    redactAndValidateTranscript(
      unmatched.records,
      validator,
      evidenceSchema,
    ),
    "UNMATCHED_SERVER_REQUEST_RESPONSE",
  );

  const unanswered = new TranscriptRecorder();
  const request = unanswered.appendServerFrame(1, 0);
  unanswered.classifyServerFrame(request, {
    kind: "server-request",
    id: "server-request-1",
    method: "execCommandApproval",
    params: {
      conversationId: "thread-native",
      callId: "call-native",
      approvalId: null,
      command: ["true"],
      cwd: "/tmp/raw-repository",
      reason: null,
      parsedCmd: [],
    },
  });
  await assertRejectsCode(
    redactAndValidateTranscript(
      unanswered.records,
      validator,
      evidenceSchema,
      { sensitivePaths: ["/tmp/raw-repository"] },
    ),
    "PENDING_SERVER_REQUEST_RESPONSE_MISSING",
  );
});

Deno.test("coverage is derived from both journal directions without mutating baseline evidence", async () => {
  const [result, validator, evidenceSchema, configuration] = await Promise.all([
    fullScenario(),
    validatorPromise,
    evidenceSchemaPromise,
    configurationPromise,
  ]);
  const beforeBytes = await Deno.readFile(configuration.coveragePath);
  const beforeHash = await sha256Hex(beforeBytes);
  const retained = await redactAndValidateTranscript(
    result.transcript,
    validator,
    evidenceSchema,
    {
      sensitivePaths: [
        scenarioRepositoryPath(result.transcript),
        configuration.repositoryRoot,
      ],
      rawTexts: [OFFLINE_PROMPT, result.agentText],
    },
  );
  const surface = await extractStableSurface(
    `${configuration.generatedRoot}/json-schema`,
  );
  const baseline = buildBaselineCoverage(
    surface,
    configuration.generation.bundleSha256,
  );
  const derived = deriveCoverageFromJournal(
    baseline,
    surface,
    retained,
  );
  validateCoverageMembership(baseline, surface, {
    requireZeroBaseline: true,
  });
  validateCoverageMembership(derived, surface);
  const fact = (
    direction: string,
    method: string,
  ) =>
    derived.entries.find((entry) =>
      entry.direction === direction && entry.method === method
    );
  assertEquals(fact("client-request", "initialize")?.observedCount, 1);
  assertEquals(fact("client-notification", "initialized")?.observedCount, 1);
  assertEquals(
    fact("server-notification", "turn/completed")?.observedCount,
    1,
  );
  assertEquals(fact("client-request", "initialize")?.disposition, "exercised");

  const disagrees = structuredClone(derived) as CoverageManifest;
  factIn(disagrees, "client-request", "initialize").observedCount++;
  await assertRejectsCode(
    Promise.resolve().then(() =>
      deriveCoverageFromJournal(
        baseline,
        surface,
        retained,
        disagrees,
      )
    ),
    "COVERAGE_JOURNAL_DISAGREEMENT",
  );
  const afterHash = await sha256Hex(
    await Deno.readFile(configuration.coveragePath),
  );
  assertEquals(afterHash, beforeHash);
});

function factIn(
  coverage: CoverageManifest,
  direction: CoverageManifest["entries"][number]["direction"],
  method: string,
): CoverageManifest["entries"][number] {
  const entry = coverage.entries.find((candidate) =>
    candidate.direction === direction && candidate.method === method
  );
  assert(entry !== undefined);
  return entry;
}

Deno.test("transcript validation errors retain stable machine-readable codes", () => {
  const error = new TranscriptValidationError("FIXTURE", "fixture");
  assertEquals(error.code, "FIXTURE");
});
