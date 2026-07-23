import type { TransportDiagnostic } from "./diagnostics.ts";
import {
  type CoverageManifest,
  type RegenerationVerifiedConfiguration,
  sha256Hex,
} from "./config.ts";
import {
  type ProtocolDirection,
  ProtocolValidator,
  validateJsonAgainstSchema,
} from "./protocol_validation.ts";
import type { ShutdownEvidence } from "./shutdown.ts";

export type RequestId = string | number;

export type ClassifiedEnvelope =
  | {
    kind: "response";
    id: RequestId;
    result?: unknown;
    error?: unknown;
  }
  | {
    kind: "server-notification";
    method: string;
    params: unknown;
  }
  | {
    kind: "server-request";
    id: RequestId;
    method: string;
    params: unknown;
  };

export type ClientProtocolRecord = {
  direction: "client";
  observationIndex: number;
  monotonicOffsetMs: number;
  method: string;
  id?: RequestId;
  params: unknown;
  byteLength: number;
};

export type ServerProtocolRecord = {
  direction: "server";
  observationIndex: number;
  wireIndex: number;
  monotonicOffsetMs: number;
  byteLength: number;
  envelope?: ClassifiedEnvelope;
  diagnostic?: TransportDiagnostic;
};

export type ProtocolRecord = ClientProtocolRecord | ServerProtocolRecord;

export class TranscriptRecorder {
  readonly #startedAt = performance.now();
  readonly #records: ProtocolRecord[] = [];
  #nextObservationIndex = 0;
  #nextWireIndex = 0;

  get records(): readonly ProtocolRecord[] {
    return this.#records;
  }

  monotonicOffsetMs(): number {
    return Math.max(0, performance.now() - this.#startedAt);
  }

  appendClient(
    envelope: {
      method: string;
      id?: RequestId;
      params?: unknown;
    },
    byteLength: number,
    monotonicOffsetMs = this.monotonicOffsetMs(),
  ): ClientProtocolRecord {
    const record: ClientProtocolRecord = {
      direction: "client",
      observationIndex: this.#nextObservationIndex++,
      monotonicOffsetMs,
      method: envelope.method,
      params: envelope.params,
      byteLength,
    };
    if (envelope.id !== undefined) record.id = envelope.id;
    this.#records.push(record);
    return record;
  }

  appendClientResponse(
    envelope: {
      id: RequestId;
      result?: unknown;
      error?: unknown;
    },
    byteLength: number,
    monotonicOffsetMs = this.monotonicOffsetMs(),
  ): ClientProtocolRecord {
    return this.appendClient(
      {
        method: "<server-request-response>",
        id: envelope.id,
        params: envelope.error === undefined
          ? { result: envelope.result }
          : { error: envelope.error },
      },
      byteLength,
      monotonicOffsetMs,
    );
  }

  appendServerFrame(
    byteLength: number,
    monotonicOffsetMs = this.monotonicOffsetMs(),
  ): ServerProtocolRecord {
    const record: ServerProtocolRecord = {
      direction: "server",
      observationIndex: this.#nextObservationIndex++,
      wireIndex: this.#nextWireIndex++,
      monotonicOffsetMs,
      byteLength,
    };
    this.#records.push(record);
    return record;
  }

  classifyServerFrame(
    record: ServerProtocolRecord,
    envelope: ClassifiedEnvelope,
  ): void {
    record.envelope = envelope;
  }

  failServerFrame(
    record: ServerProtocolRecord,
    diagnostic: TransportDiagnostic,
  ): void {
    record.diagnostic = diagnostic;
  }
}

export type NativeIds = {
  threadId?: string;
  turnId?: string;
  itemId?: string;
};

export type RetainedProtocolRecord = ProtocolRecord & {
  schema: { id: string; valid: true };
  nativeIds: NativeIds;
};

export type LiveMeasurements = {
  spawnToInitializeResponse: number;
  initializeToReady: number;
  turnStartToFirstEvent: number;
  turnStartToCompleted: number;
  stdinCloseToExit: number;
  totalShutdown: number;
};

export type VerifyOnlyCandidate = {
  transcript: readonly RetainedProtocolRecord[];
  coverage: CoverageManifest;
  summaryInputs: {
    versions: { deno: "2.9.3"; codex: "0.145.0" };
    platform: { os: "darwin"; arch: "aarch64" };
    observationsMs: LiveMeasurements;
    lifecycle: {
      stdoutLines: number;
      stderrBytes: number;
      threadId: string;
      turnId: string;
      terminalStatus: "completed";
      completedItems: number;
      completedAgentMessages: number;
    };
    shutdown: ShutdownEvidence;
    gates: {
      exactVersions: true;
      generatedArtifactsMatch: true;
      coverageComplete: true;
      everyRetainedEnvelopeSchemaValid: true;
      lifecycleOrdered: true;
      authenticatedTurnCompleted: true;
      noObservedDescendantsRemain: true;
    };
  };
};

export class TranscriptValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "TranscriptValidationError";
  }
}

type ItemLifecycle = {
  type: string;
  startedAtWireIndex: number;
  deltaWireIndexes: number[];
  textDeltas: string[];
  completedAtWireIndex?: number;
  completedText?: string;
};

export type LifecycleResult = {
  threadId: string;
  turnId: string;
  terminalStatus: "completed" | "interrupted" | "failed";
  completedItems: number;
  completedAgentMessages: number;
  agentText: string;
};

function objectRecord(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TranscriptValidationError(
      "LIFECYCLE_PAYLOAD_INVALID",
      `${context} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  field: string,
  context: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TranscriptValidationError(
      "LIFECYCLE_ID_INVALID",
      `${context}.${field} must be a non-empty string`,
    );
  }
  return value;
}

export class LifecycleReducer {
  #threadId?: string;
  #turnId?: string;
  #lastWireIndex = -1;
  #terminalStatus?: "completed" | "interrupted" | "failed";
  #items = new Map<string, ItemLifecycle>();

  establishThread(threadId: string): void {
    if (this.#threadId !== undefined && this.#threadId !== threadId) {
      throw new TranscriptValidationError(
        "THREAD_ID_MISMATCH",
        "native thread identity changed during the scenario",
        { expected: this.#threadId, observed: threadId },
      );
    }
    this.#threadId = threadId;
  }

  establishTurn(threadId: string, turnId: string): void {
    this.#requireThread(threadId, "turn/start");
    if (this.#turnId !== undefined && this.#turnId !== turnId) {
      throw new TranscriptValidationError(
        "TURN_ID_MISMATCH",
        "native turn identity changed during the scenario",
        { expected: this.#turnId, observed: turnId },
      );
    }
    this.#turnId = turnId;
  }

  observeServerNotification(
    method: string,
    params: unknown,
    wireIndex: number,
  ): void {
    if (!Number.isSafeInteger(wireIndex) || wireIndex <= this.#lastWireIndex) {
      throw new TranscriptValidationError(
        "WIRE_ORDER_INVALID",
        "server lifecycle notifications must preserve increasing wire order",
        { previous: this.#lastWireIndex, observed: wireIndex },
      );
    }
    this.#lastWireIndex = wireIndex;
    if (this.#terminalStatus !== undefined) {
      throw new TranscriptValidationError(
        "LIFECYCLE_AFTER_TERMINAL",
        `received ${method} after terminal turn state`,
      );
    }
    const record = objectRecord(params, method);

    if (method === "thread/started") {
      const thread = objectRecord(record.thread, `${method}.thread`);
      this.establishThread(
        requiredString(thread.id, "id", `${method}.thread`),
      );
      return;
    }

    if (method === "turn/started") {
      const threadId = requiredString(record.threadId, "threadId", method);
      const turn = objectRecord(record.turn, `${method}.turn`);
      const turnId = requiredString(turn.id, "id", `${method}.turn`);
      this.establishTurn(threadId, turnId);
      return;
    }

    if (method === "item/started") {
      const { threadId, turnId } = this.#requireTurnRecord(record, method);
      this.#requireThread(threadId, method);
      this.#requireTurn(turnId, method);
      const item = objectRecord(record.item, `${method}.item`);
      const itemId = requiredString(item.id, "id", `${method}.item`);
      if (this.#items.has(itemId)) {
        throw new TranscriptValidationError(
          "ITEM_START_DUPLICATE",
          `item ${itemId} started more than once`,
        );
      }
      this.#items.set(itemId, {
        type: requiredString(item.type, "type", `${method}.item`),
        startedAtWireIndex: wireIndex,
        deltaWireIndexes: [],
        textDeltas: [],
      });
      return;
    }

    if (method === "item/completed") {
      const { threadId, turnId } = this.#requireTurnRecord(record, method);
      this.#requireThread(threadId, method);
      this.#requireTurn(turnId, method);
      const item = objectRecord(record.item, `${method}.item`);
      const itemId = requiredString(item.id, "id", `${method}.item`);
      const lifecycle = this.#requireActiveItem(itemId, method);
      lifecycle.completedAtWireIndex = wireIndex;
      if (lifecycle.type === "agentMessage") {
        if (typeof item.text !== "string") {
          throw new TranscriptValidationError(
            "AGENT_TEXT_INVALID",
            `${method}.item.text must be a string`,
          );
        }
        const completedText = item.text;
        const reconstructed = lifecycle.textDeltas.join("");
        if (reconstructed !== completedText) {
          throw new TranscriptValidationError(
            "AGENT_TEXT_MISMATCH",
            "ordered agent deltas do not reconstruct the completed item",
            { reconstructed, completedText },
          );
        }
        lifecycle.completedText = completedText;
      }
      return;
    }

    if (method === "turn/completed") {
      const threadId = requiredString(record.threadId, "threadId", method);
      this.#requireThread(threadId, method);
      const turn = objectRecord(record.turn, `${method}.turn`);
      const turnId = requiredString(turn.id, "id", `${method}.turn`);
      this.#requireTurn(turnId, method);
      const status = turn.status;
      if (
        status !== "completed" && status !== "interrupted" &&
        status !== "failed"
      ) {
        throw new TranscriptValidationError(
          "TURN_TERMINAL_STATUS_INVALID",
          `turn/completed carried non-terminal status ${String(status)}`,
        );
      }
      const incomplete = [...this.#items.entries()]
        .filter(([, item]) => item.completedAtWireIndex === undefined)
        .map(([itemId]) => itemId);
      if (incomplete.length > 0) {
        throw new TranscriptValidationError(
          "ITEMS_INCOMPLETE_AT_TERMINAL",
          "turn became terminal while items were incomplete",
          { incomplete },
        );
      }
      this.#terminalStatus = status;
      return;
    }

    if (
      method.startsWith("item/") &&
      "threadId" in record &&
      "turnId" in record &&
      "itemId" in record
    ) {
      const { threadId, turnId } = this.#requireTurnRecord(record, method);
      this.#requireThread(threadId, method);
      this.#requireTurn(turnId, method);
      const itemId = requiredString(record.itemId, "itemId", method);
      const item = this.#requireActiveItem(itemId, method);
      item.deltaWireIndexes.push(wireIndex);
      if (method === "item/agentMessage/delta") {
        if (item.type !== "agentMessage") {
          throw new TranscriptValidationError(
            "AGENT_DELTA_ITEM_TYPE_MISMATCH",
            "agent message delta targeted a non-agent item",
            { itemId, itemType: item.type },
          );
        }
        if (typeof record.delta !== "string") {
          throw new TranscriptValidationError(
            "AGENT_DELTA_INVALID",
            "agent message delta must contain text",
          );
        }
        item.textDeltas.push(record.delta);
      }
    }
  }

  finish(options: { requireCompleted?: boolean } = {}): LifecycleResult {
    if (
      this.#threadId === undefined || this.#turnId === undefined ||
      this.#terminalStatus === undefined
    ) {
      throw new TranscriptValidationError(
        "LIFECYCLE_INCOMPLETE",
        "thread, turn, and terminal identities are required",
      );
    }
    const completedAgentMessages = [...this.#items.values()].filter((item) =>
      item.type === "agentMessage" &&
      item.completedAtWireIndex !== undefined &&
      (item.completedText?.length ?? 0) > 0
    );
    if (options.requireCompleted && this.#terminalStatus !== "completed") {
      throw new TranscriptValidationError(
        "TURN_NOT_COMPLETED",
        `compatibility requires completed, observed ${this.#terminalStatus}`,
      );
    }
    if (options.requireCompleted && completedAgentMessages.length === 0) {
      throw new TranscriptValidationError(
        "AGENT_TEXT_EMPTY",
        "compatibility requires a non-empty completed agent message",
      );
    }
    return {
      threadId: this.#threadId,
      turnId: this.#turnId,
      terminalStatus: this.#terminalStatus,
      completedItems:
        [...this.#items.values()].filter((item) =>
          item.completedAtWireIndex !== undefined
        ).length,
      completedAgentMessages: completedAgentMessages.length,
      agentText: completedAgentMessages.map((item) => item.completedText)
        .join("\n"),
    };
  }

  #requireTurnRecord(
    record: Record<string, unknown>,
    context: string,
  ): { threadId: string; turnId: string } {
    return {
      threadId: requiredString(record.threadId, "threadId", context),
      turnId: requiredString(record.turnId, "turnId", context),
    };
  }

  #requireThread(threadId: string, context: string): void {
    if (this.#threadId === undefined) {
      throw new TranscriptValidationError(
        "THREAD_NOT_ESTABLISHED",
        `${context} occurred before thread/start established an identity`,
      );
    }
    if (this.#threadId !== threadId) {
      throw new TranscriptValidationError(
        "THREAD_ID_MISMATCH",
        `${context} used a different native thread`,
        { expected: this.#threadId, observed: threadId },
      );
    }
  }

  #requireTurn(turnId: string, context: string): void {
    if (this.#turnId === undefined) {
      throw new TranscriptValidationError(
        "TURN_NOT_ESTABLISHED",
        `${context} occurred before turn/start established an identity`,
      );
    }
    if (this.#turnId !== turnId) {
      throw new TranscriptValidationError(
        "TURN_ID_MISMATCH",
        `${context} used a different native turn`,
        { expected: this.#turnId, observed: turnId },
      );
    }
  }

  #requireActiveItem(itemId: string, context: string): ItemLifecycle {
    const item = this.#items.get(itemId);
    if (item === undefined) {
      throw new TranscriptValidationError(
        "ITEM_NOT_STARTED",
        `${context} targeted item ${itemId} before item/started`,
      );
    }
    if (item.completedAtWireIndex !== undefined) {
      throw new TranscriptValidationError(
        "ITEM_ALREADY_COMPLETED",
        `${context} targeted completed item ${itemId}`,
      );
    }
    return item;
  }
}

const CREDENTIAL_KEY =
  /(?:^tokens?$|(?:access|refresh|bearer|auth|authentication|id)[_-]?tokens?$|api[_-]?keys?$|authorization$|cookies?$|credentials?$|passwords?$|secrets?$)/i;
const ACCOUNT_IDENTIFIER_KEY =
  /(?:accountId|accountUserId|userId|organizationId|email)$/i;
const TEXT_KEY =
  /^(?:delta|description|message|preview|prompt|response|text)$/i;
const PATH_KEY =
  /(?:codexHome|cwd|homePath|instructionSources|path|repositoryPath)$/i;
const DIRECT_HOME_PATH = /^(?:\/Users\/|\/home\/)/;
const CREDENTIAL_VALUE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{16,}|\b(?:access|refresh|auth|id)[_-]?token\s*[:=]\s*\S+)/i;

async function replacement(
  label: string,
  value: string,
): Promise<string> {
  return `[redacted-${label}:sha256:${await sha256Hex(
    new TextEncoder().encode(value),
  )}]`;
}

export async function redactProtocolValue(
  value: unknown,
  options: {
    sensitivePaths?: readonly string[];
    rawTexts?: readonly string[];
  } = {},
  key = "",
  pathContext = false,
): Promise<unknown> {
  if (
    CREDENTIAL_KEY.test(key) &&
    typeof value !== "boolean" &&
    value !== null
  ) {
    throw new TranscriptValidationError(
      "CREDENTIAL_FIELD_REJECTED",
      `credential material in field ${key} cannot be retained`,
    );
  }
  if (typeof value === "string") {
    if (ACCOUNT_IDENTIFIER_KEY.test(key)) {
      const digest = await sha256Hex(new TextEncoder().encode(value));
      return key.toLowerCase().endsWith("email")
        ? `account-${digest.slice(0, 16)}@redacted.invalid`
        : `account-${digest.slice(0, 24)}`;
    }
    const sensitivePath = options.sensitivePaths?.find((path) =>
      path.length > 0 && value.includes(path)
    );
    if (pathContext || DIRECT_HOME_PATH.test(value) || sensitivePath) {
      return `/redacted/path/${
        (await sha256Hex(new TextEncoder().encode(value))).slice(0, 24)
      }`;
    }
    if (
      TEXT_KEY.test(key) ||
      options.rawTexts?.some((text) => text.length > 0 && value.includes(text))
    ) {
      return await replacement("text", value);
    }
    return value;
  }
  if (typeof value === "number" && ACCOUNT_IDENTIFIER_KEY.test(key)) {
    const digest = await sha256Hex(new TextEncoder().encode(String(value)));
    return -(2 ** 48 + Number.parseInt(digest.slice(0, 12), 16) + 1);
  }
  if (Array.isArray(value)) {
    return await Promise.all(
      value.map((entry) =>
        redactProtocolValue(
          entry,
          options,
          key,
          pathContext || PATH_KEY.test(key),
        )
      ),
    );
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value)) {
      result[entryKey] = await redactProtocolValue(
        entry,
        options,
        entryKey,
        PATH_KEY.test(entryKey),
      );
    }
    return result;
  }
  return value;
}

function collectAccountIdentifiers(
  value: unknown,
  key = "",
  result = new Set<string>(),
): ReadonlySet<string> {
  if (
    (typeof value === "string" || typeof value === "number") &&
    ACCOUNT_IDENTIFIER_KEY.test(key)
  ) {
    result.add(String(value));
  } else if (Array.isArray(value)) {
    for (const entry of value) collectAccountIdentifiers(entry, key, result);
  } else if (value !== null && typeof value === "object") {
    for (const [entryKey, entry] of Object.entries(value)) {
      collectAccountIdentifiers(entry, entryKey, result);
    }
  }
  return result;
}

function assertSensitiveValuesAbsent(
  value: unknown,
  options: {
    sensitivePaths: readonly string[];
    rawTexts: readonly string[];
    account: Record<string, unknown>;
  },
): void {
  const encoded = JSON.stringify(value);
  const forbidden = [
    ...options.sensitivePaths,
    ...options.rawTexts,
    ...collectAccountIdentifiers(options.account),
  ];
  for (const sensitive of forbidden) {
    if (sensitive.length > 0 && encoded.includes(sensitive)) {
      throw new TranscriptValidationError(
        "SENSITIVE_VALUE_RETAINED",
        "verify-only candidate data contains a supplied sensitive value",
      );
    }
  }
  if (/(?:\/Users\/|\/home\/)/.test(encoded)) {
    throw new TranscriptValidationError(
      "DIRECT_HOME_PATH_RETAINED",
      "verify-only candidate data contains a direct home path",
    );
  }
  if (CREDENTIAL_VALUE.test(encoded)) {
    throw new TranscriptValidationError(
      "CREDENTIAL_VALUE_REJECTED",
      "verify-only candidate data contains credential-like material",
    );
  }
}

function requireMeasurement(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TranscriptValidationError(
      "MEASUREMENT_INVALID",
      `${name} must be a non-negative monotonic observation`,
      { name },
    );
  }
  return value;
}

export function buildVerifyOnlyCandidate(options: {
  configuration: RegenerationVerifiedConfiguration;
  lifecycle: LifecycleResult;
  measurements: Omit<
    LiveMeasurements,
    "stdinCloseToExit" | "totalShutdown"
  >;
  retained: readonly RetainedProtocolRecord[];
  coverage: CoverageManifest;
  shutdown: ShutdownEvidence;
  stderrBytes: number;
  stderrText: string;
  evidenceSchema: unknown;
  account: Record<string, unknown>;
  sensitivePaths: readonly string[];
  rawTexts: readonly string[];
}): VerifyOnlyCandidate {
  const shutdown = options.shutdown;
  if (
    shutdown.directExit === undefined ||
    shutdown.drains.stdoutCompleted !== true ||
    shutdown.drains.stderrCompleted !== true ||
    shutdown.remainingPids.length !== 0 ||
    shutdown.noObservedDescendantsRemain !== true
  ) {
    throw new TranscriptValidationError(
      "SHUTDOWN_GATE_FAILED",
      "verify-only eligibility requires settled status/drains and an empty observed tree",
      {
        directExitSettled: shutdown.directExit !== undefined,
        drains: shutdown.drains,
        remainingPids: shutdown.remainingPids,
        noObservedDescendantsRemain: shutdown.noObservedDescendantsRemain,
      },
    );
  }
  if (typeof shutdown.escapedDescendantContainmentProven !== "boolean") {
    throw new TranscriptValidationError(
      "CONTAINMENT_FACT_MISSING",
      "escaped-descendant containment must remain an explicit evidence fact",
    );
  }
  const escapedDescendantContainmentProven = Boolean(
    shutdown.escapedDescendantContainmentProven,
  );
  if (escapedDescendantContainmentProven) {
    const capability = shutdown.containmentCapability;
    if (
      !capability.available || !capability.armedBeforeChildExecution ||
      !capability.continuouslyTracked || !capability.creationEventsCovered ||
      !capability.sessionEscapeCovered || !capability.reparentingCovered ||
      capability.lossDetected || capability.overflowed
    ) {
      throw new TranscriptValidationError(
        "CONTAINMENT_PROOF_UNSUPPORTED",
        "escaped-descendant containment cannot be true without race-closing capability evidence",
      );
    }
  }
  const stdinClosedAt = shutdown.timings.stdinClosedAtMs;
  const directExitAt = shutdown.timings.directExitAtMs;
  if (stdinClosedAt === undefined || directExitAt === undefined) {
    throw new TranscriptValidationError(
      "MEASUREMENT_RECORD_MISSING",
      "shutdown must record stdin close and direct exit observations",
    );
  }
  const observationsMs: LiveMeasurements = {
    spawnToInitializeResponse: requireMeasurement(
      "spawnToInitializeResponse",
      options.measurements.spawnToInitializeResponse,
    ),
    initializeToReady: requireMeasurement(
      "initializeToReady",
      options.measurements.initializeToReady,
    ),
    turnStartToFirstEvent: requireMeasurement(
      "turnStartToFirstEvent",
      options.measurements.turnStartToFirstEvent,
    ),
    turnStartToCompleted: requireMeasurement(
      "turnStartToCompleted",
      options.measurements.turnStartToCompleted,
    ),
    stdinCloseToExit: requireMeasurement(
      "stdinCloseToExit",
      directExitAt - stdinClosedAt,
    ),
    totalShutdown: requireMeasurement(
      "totalShutdown",
      shutdown.timings.totalMs,
    ),
  };
  const evidence = options.evidenceSchema as Record<string, unknown>;
  validateJsonAgainstSchema(
    {
      $schema: evidence.$schema,
      definitions: evidence.definitions,
      $ref: "#/definitions/shutdownEvidence",
    },
    shutdown,
    "SHUTDOWN_EVIDENCE_SCHEMA_INVALID",
  );
  if (
    options.lifecycle.terminalStatus !== "completed" ||
    options.lifecycle.completedAgentMessages < 1 ||
    options.lifecycle.agentText.length === 0
  ) {
    throw new TranscriptValidationError(
      "AUTHENTICATED_TURN_INCOMPLETE",
      "verify-only eligibility requires one completed turn with agent content",
    );
  }
  if (
    options.retained.some((record) =>
      record.schema.valid !== true || record.schema.id.length === 0
    )
  ) {
    throw new TranscriptValidationError(
      "RETAINED_SCHEMA_PROOF_MISSING",
      "every verify-only record must retain a pinned schema proof",
    );
  }
  const candidate: VerifyOnlyCandidate = {
    transcript: options.retained,
    coverage: options.coverage,
    summaryInputs: {
      versions: { deno: "2.9.3", codex: "0.145.0" },
      platform: { os: "darwin", arch: "aarch64" },
      observationsMs,
      lifecycle: {
        stdoutLines:
          options.retained.filter((record) => record.direction === "server")
            .length,
        stderrBytes: options.stderrBytes,
        threadId: options.lifecycle.threadId,
        turnId: options.lifecycle.turnId,
        terminalStatus: "completed",
        completedItems: options.lifecycle.completedItems,
        completedAgentMessages: options.lifecycle.completedAgentMessages,
      },
      shutdown,
      gates: {
        exactVersions: true,
        generatedArtifactsMatch: true,
        coverageComplete: true,
        everyRetainedEnvelopeSchemaValid: true,
        lifecycleOrdered: true,
        authenticatedTurnCompleted: true,
        noObservedDescendantsRemain: true,
      },
    },
  };
  assertSensitiveValuesAbsent(
    { candidate, stderr: options.stderrText },
    {
      sensitivePaths: options.sensitivePaths,
      rawTexts: options.rawTexts,
      account: options.account,
    },
  );
  return candidate;
}

function clientEnvelope(record: ClientProtocolRecord): Record<string, unknown> {
  const envelope: Record<string, unknown> = { method: record.method };
  if (record.id !== undefined) envelope.id = record.id;
  if (record.params !== undefined) envelope.params = record.params;
  return envelope;
}

function methodForServerResponse(
  pending: Map<RequestId, string>,
  envelope: Extract<ClassifiedEnvelope, { kind: "response" }>,
): string {
  const method = pending.get(envelope.id);
  if (method === undefined) {
    throw new TranscriptValidationError(
      "UNMATCHED_RESPONSE",
      `response ${String(envelope.id)} has no pending client request`,
    );
  }
  pending.delete(envelope.id);
  return method;
}

function responseEnvelopeForClientRecord(
  record: ClientProtocolRecord,
): Record<string, unknown> {
  if (record.id === undefined) {
    throw new TranscriptValidationError(
      "UNMATCHED_SERVER_REQUEST_RESPONSE",
      "a server-request response must retain its request ID",
    );
  }
  const params = record.params !== null && typeof record.params === "object" &&
      !Array.isArray(record.params)
    ? record.params as Record<string, unknown>
    : {};
  const hasResult = Object.hasOwn(params, "result");
  const hasError = Object.hasOwn(params, "error");
  if (hasResult === hasError) {
    throw new TranscriptValidationError(
      "SERVER_REQUEST_RESPONSE_INVALID",
      "a server-request response must contain exactly one result or error",
      { requestId: record.id },
    );
  }
  return hasResult
    ? { id: record.id, result: params.result }
    : { id: record.id, error: params.error };
}

function protocolDirectionForClient(
  record: ClientProtocolRecord,
): "client-request" | "client-notification" {
  return record.id === undefined ? "client-notification" : "client-request";
}

function nativeIds(method: string, value: unknown): NativeIds {
  const record = value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const source = record.params !== null && typeof record.params === "object"
    ? record.params as Record<string, unknown>
    : record.result !== null && typeof record.result === "object"
    ? record.result as Record<string, unknown>
    : record;
  const ids: NativeIds = {};
  if (typeof source.threadId === "string") ids.threadId = source.threadId;
  if (typeof source.turnId === "string") ids.turnId = source.turnId;
  if (typeof source.itemId === "string") ids.itemId = source.itemId;
  const thread = source.thread !== null && typeof source.thread === "object"
    ? source.thread as Record<string, unknown>
    : undefined;
  const turn = source.turn !== null && typeof source.turn === "object"
    ? source.turn as Record<string, unknown>
    : undefined;
  const item = source.item !== null && typeof source.item === "object"
    ? source.item as Record<string, unknown>
    : undefined;
  if (ids.threadId === undefined && typeof thread?.id === "string") {
    ids.threadId = thread.id;
  }
  if (ids.turnId === undefined && typeof turn?.id === "string") {
    ids.turnId = turn.id;
  }
  if (ids.itemId === undefined && typeof item?.id === "string") {
    ids.itemId = item.id;
  }
  if (method === "thread/start" && typeof thread?.id === "string") {
    ids.threadId = thread.id;
  }
  return ids;
}

function assertRecordOrder(records: readonly ProtocolRecord[]): void {
  let wireIndex = -1;
  records.forEach((record, index) => {
    if (record.observationIndex !== index) {
      throw new TranscriptValidationError(
        "OBSERVATION_ORDER_INVALID",
        "observation indexes must be contiguous and ordered",
        { expected: index, observed: record.observationIndex },
      );
    }
    if (record.direction === "server") {
      if (record.wireIndex !== wireIndex + 1) {
        throw new TranscriptValidationError(
          "WIRE_ORDER_INVALID",
          "server wire indexes must be contiguous and ordered",
          { expected: wireIndex + 1, observed: record.wireIndex },
        );
      }
      wireIndex = record.wireIndex;
    }
  });
}

export async function redactAndValidateTranscript(
  records: readonly ProtocolRecord[],
  validator: ProtocolValidator,
  evidenceSchema: unknown,
  options: {
    sensitivePaths?: readonly string[];
    rawTexts?: readonly string[];
  } = {},
): Promise<RetainedProtocolRecord[]> {
  assertRecordOrder(records);
  const pending = new Map<RequestId, string>();
  const pendingServerRequests = new Map<RequestId, string>();
  const retained: RetainedProtocolRecord[] = [];

  for (const record of records) {
    if (record.direction === "client") {
      if (record.method === "<server-request-response>") {
        const method = record.id === undefined
          ? undefined
          : pendingServerRequests.get(record.id);
        if (method === undefined) {
          throw new TranscriptValidationError(
            "UNMATCHED_SERVER_REQUEST_RESPONSE",
            `client response ${String(record.id)} has no prior server request`,
          );
        }
        const rawEnvelope = responseEnvelopeForClientRecord(record);
        validator.validateResponseEnvelope(
          "server-request",
          method,
          rawEnvelope,
        );
        pendingServerRequests.delete(record.id!);
        const redactedEnvelope = await redactProtocolValue(
          rawEnvelope,
          options,
        ) as Record<string, unknown>;
        validator.validateResponseEnvelope(
          "server-request",
          method,
          redactedEnvelope,
        );
        const redactedValue: Record<string, unknown> = {
          direction: "client",
          observationIndex: record.observationIndex,
          monotonicOffsetMs: record.monotonicOffsetMs,
          method: record.method,
          id: record.id,
          params: "result" in redactedEnvelope
            ? { result: redactedEnvelope.result }
            : { error: redactedEnvelope.error },
          byteLength: record.byteLength,
          schema: {
            id: `server-request-response:${method}`,
            valid: true,
          },
          nativeIds: nativeIds(method, redactedEnvelope),
        };
        const redacted = redactedValue as RetainedProtocolRecord;
        validateJsonAgainstSchema(
          evidenceSchema,
          redacted,
          "EVIDENCE_SCHEMA_INVALID",
        );
        retained.push(redacted);
        continue;
      }
      const direction = protocolDirectionForClient(record);
      const rawEnvelope = clientEnvelope(record);
      validator.validateEnvelope(direction, rawEnvelope);
      if (direction === "client-request") {
        pending.set(record.id!, record.method);
      }
      const redactedEnvelope = await redactProtocolValue(
        rawEnvelope,
        options,
      ) as Record<string, unknown>;
      validator.validateEnvelope(direction, redactedEnvelope);
      const redactedValue: Record<string, unknown> = {
        direction: "client",
        observationIndex: record.observationIndex,
        monotonicOffsetMs: record.monotonicOffsetMs,
        method: record.method,
        byteLength: record.byteLength,
        schema: { id: `${direction}:${record.method}`, valid: true },
        nativeIds: nativeIds(record.method, redactedEnvelope),
      };
      if (record.id !== undefined) redactedValue.id = record.id;
      if (redactedEnvelope.params !== undefined) {
        redactedValue.params = redactedEnvelope.params;
      }
      const redacted = redactedValue as RetainedProtocolRecord;
      validateJsonAgainstSchema(
        evidenceSchema,
        redacted,
        "EVIDENCE_SCHEMA_INVALID",
      );
      retained.push(redacted);
      continue;
    }

    if (record.diagnostic !== undefined || record.envelope === undefined) {
      throw new TranscriptValidationError(
        "RAW_SERVER_RECORD_INVALID",
        "failed or unclassified server frames cannot become retained evidence",
        { wireIndex: record.wireIndex },
      );
    }
    const envelope = record.envelope;
    let method: string;
    let direction: ProtocolDirection | "client-response";
    if (envelope.kind === "response") {
      method = methodForServerResponse(pending, envelope);
      direction = "client-response";
      validator.validateResponseEnvelope(
        "client-request",
        method,
        responseEnvelope(envelope),
      );
    } else {
      method = envelope.method;
      direction = envelope.kind === "server-notification"
        ? "server-notification"
        : "server-request";
      validator.validateEnvelope(direction, protocolEnvelope(envelope));
      if (envelope.kind === "server-request") {
        if (pendingServerRequests.has(envelope.id)) {
          throw new TranscriptValidationError(
            "DUPLICATE_SERVER_REQUEST_ID",
            `server request ${String(envelope.id)} was observed more than once`,
          );
        }
        pendingServerRequests.set(envelope.id, envelope.method);
      }
    }
    const redactedEnvelope = await redactProtocolValue(
      protocolEnvelope(envelope),
      options,
    ) as Record<string, unknown>;
    if (envelope.kind === "response") {
      validator.validateResponseEnvelope(
        "client-request",
        method,
        redactedEnvelope,
      );
    } else {
      validator.validateEnvelope(
        direction as ProtocolDirection,
        redactedEnvelope,
      );
    }
    const classified = classifiedEnvelope(redactedEnvelope);
    const redacted: RetainedProtocolRecord = {
      ...record,
      envelope: classified,
      schema: { id: `${direction}:${method}`, valid: true },
      nativeIds: nativeIds(method, redactedEnvelope),
    };
    validateJsonAgainstSchema(
      evidenceSchema,
      redacted,
      "EVIDENCE_SCHEMA_INVALID",
    );
    retained.push(redacted);
  }

  if (pending.size > 0) {
    throw new TranscriptValidationError(
      "PENDING_RESPONSE_MISSING",
      "retained transcript ended with unmatched client requests",
      { requestIds: [...pending.keys()] },
    );
  }
  if (pendingServerRequests.size > 0) {
    throw new TranscriptValidationError(
      "PENDING_SERVER_REQUEST_RESPONSE_MISSING",
      "retained transcript ended with unanswered server requests",
      { requestIds: [...pendingServerRequests.keys()] },
    );
  }
  const encoded = JSON.stringify(retained);
  for (
    const sensitive of [
      ...(options.sensitivePaths ?? []),
      ...(options.rawTexts ?? []),
    ]
  ) {
    if (sensitive.length > 0 && encoded.includes(sensitive)) {
      throw new TranscriptValidationError(
        "SENSITIVE_VALUE_RETAINED",
        "redacted transcript still contains a supplied sensitive value",
      );
    }
  }
  if (/(?:\/Users\/|\/home\/)/.test(encoded)) {
    throw new TranscriptValidationError(
      "DIRECT_HOME_PATH_RETAINED",
      "redacted transcript still contains a direct home path",
    );
  }
  return retained;
}

function protocolEnvelope(
  envelope: ClassifiedEnvelope,
): Record<string, unknown> {
  if (envelope.kind === "response") return responseEnvelope(envelope);
  const raw: Record<string, unknown> = {
    method: envelope.method,
    params: envelope.params,
  };
  if (envelope.kind === "server-request") raw.id = envelope.id;
  return raw;
}

function responseEnvelope(
  envelope: Extract<ClassifiedEnvelope, { kind: "response" }>,
): Record<string, unknown> {
  return envelope.error === undefined
    ? { id: envelope.id, result: envelope.result }
    : { id: envelope.id, error: envelope.error };
}

function classifiedEnvelope(
  envelope: Record<string, unknown>,
): ClassifiedEnvelope {
  if ("method" in envelope) {
    if ("id" in envelope) {
      return {
        kind: "server-request",
        id: envelope.id as RequestId,
        method: String(envelope.method),
        params: envelope.params,
      };
    }
    return {
      kind: "server-notification",
      method: String(envelope.method),
      params: envelope.params,
    };
  }
  return "error" in envelope
    ? {
      kind: "response",
      id: envelope.id as RequestId,
      error: envelope.error,
    }
    : {
      kind: "response",
      id: envelope.id as RequestId,
      result: envelope.result,
    };
}

export function validateLifecycleRecords(
  records: readonly ProtocolRecord[],
  expected: { threadId: string; turnId: string },
): LifecycleResult {
  const reducer = new LifecycleReducer();
  reducer.establishThread(expected.threadId);
  reducer.establishTurn(expected.threadId, expected.turnId);
  let initializeCount = 0;
  let initializedCount = 0;
  let threadStartCount = 0;
  let turnStartCount = 0;
  for (const record of records) {
    if (record.direction === "client") {
      if (record.method === "initialize") initializeCount++;
      if (record.method === "initialized") {
        if (initializeCount !== 1) {
          throw new TranscriptValidationError(
            "INITIALIZATION_ORDER_INVALID",
            "initialized must follow exactly one initialize request",
          );
        }
        initializedCount++;
      }
      if (record.method === "thread/start") threadStartCount++;
      if (record.method === "turn/start") {
        turnStartCount++;
        const params = objectRecord(record.params, "turn/start params");
        if (params.threadId !== expected.threadId) {
          throw new TranscriptValidationError(
            "THREAD_ID_MISMATCH",
            "turn/start used a different native thread",
            { expected: expected.threadId, observed: params.threadId },
          );
        }
      }
    }
    if (
      record.direction === "server" &&
      record.envelope?.kind === "server-notification" &&
      (
        record.envelope.method === "thread/started" ||
        record.envelope.method === "turn/started" ||
        record.envelope.method === "item/started" ||
        record.envelope.method === "item/completed" ||
        record.envelope.method === "turn/completed" ||
        record.envelope.method.startsWith("item/")
      )
    ) {
      reducer.observeServerNotification(
        record.envelope.method,
        record.envelope.params,
        record.wireIndex,
      );
    }
  }
  if (
    initializeCount !== 1 || initializedCount !== 1 ||
    threadStartCount !== 1 || turnStartCount !== 1
  ) {
    throw new TranscriptValidationError(
      "LIFECYCLE_REQUEST_COUNTS_INVALID",
      "scenario requires one initialize, initialized, thread/start, and turn/start",
      { initializeCount, initializedCount, threadStartCount, turnStartCount },
    );
  }
  return reducer.finish({ requireCompleted: true });
}
