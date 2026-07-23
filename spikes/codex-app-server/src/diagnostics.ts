export type TransportDiagnosticCode =
  | "PROCESS_SPAWN_FAILED"
  | "PROCESS_EXITED"
  | "STREAM_FAILED"
  | "FRAME_TOO_LARGE"
  | "INCOMPLETE_FRAME"
  | "UTF8_INVALID"
  | "JSON_INVALID"
  | "ENVELOPE_INVALID"
  | "SCHEMA_INVALID"
  | "UNKNOWN_METHOD"
  | "UNKNOWN_SERVER_REQUEST"
  | "CORRELATION_UNKNOWN_ID"
  | "CORRELATION_DUPLICATE_ID"
  | "QUEUE_OVERFLOW"
  | "REQUEST_TIMEOUT"
  | "WRITE_FAILED"
  | "INITIALIZE_DUPLICATE"
  | "INITIALIZATION_REQUIRED"
  | "CLIENT_CLOSED"
  | "EOF_WITH_PENDING"
  | "CLOSE_FAILED"
  | "PLATFORM_UNSUPPORTED"
  | "UNSAFE_PROCESS_GROUP"
  | "GRACEFUL_SHUTDOWN_TIMEOUT"
  | "TERMINATE_TIMEOUT"
  | "FORCE_TIMEOUT"
  | "DESCENDANT_LEAK"
  | "TRACKER_UNAVAILABLE"
  | "TRACKER_LOST"
  | "TRACKER_OVERFLOWED"
  | "CONTAINMENT_UNPROVEN";

export type DiagnosticPlatform = {
  os: string;
  arch: string;
};

export type TransportDiagnostic = {
  code: TransportDiagnosticCode;
  stage: string;
  message: string;
  expected?: unknown;
  observed?: unknown;
  platform: DiagnosticPlatform;
  executablePath?: string;
  method?: string;
  requestId?: string | number;
  stderr?: string;
  nextAction: string;
};

export class TransportError extends Error {
  constructor(public readonly diagnostic: TransportDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = "TransportError";
  }

  get code(): TransportDiagnosticCode {
    return this.diagnostic.code;
  }
}

const CREDENTIAL_KEY =
  /(?:authorization|cookie|credential|password|secret|session|token|api[_-]?key)/i;
const DIRECT_PATH =
  /(?:\/Users\/[^/\s"',}]+|\/home\/[^/\s"',}]+)(?:\/[^\s"',}]*)?/g;

function redactString(
  value: string,
  sensitiveValues: readonly string[],
): string {
  let result = value.replace(DIRECT_PATH, "<redacted-path>");
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0) {
      result = result.replaceAll(sensitive, "[REDACTED]");
    }
  }
  return result;
}

export function redactDiagnosticValue(
  value: unknown,
  sensitiveValues: readonly string[] = [],
  key = "",
): unknown {
  if (CREDENTIAL_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value, sensitiveValues);
  if (Array.isArray(value)) {
    return value.map((entry) =>
      redactDiagnosticValue(entry, sensitiveValues, key)
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map((
        [entryKey, entry],
      ) => [
        entryKey,
        redactDiagnosticValue(entry, sensitiveValues, entryKey),
      ]),
    );
  }
  return value;
}

export type DiagnosticInput =
  & Omit<TransportDiagnostic, "platform" | "message">
  & {
    message?: string;
    platform?: DiagnosticPlatform;
    sensitiveValues?: readonly string[];
  };

export function createTransportDiagnostic(
  input: DiagnosticInput,
): TransportDiagnostic {
  const sensitiveValues = input.sensitiveValues ?? [];
  const platform = input.platform ?? {
    os: Deno.build.os,
    arch: Deno.build.arch,
  };
  const diagnostic: TransportDiagnostic = {
    code: input.code,
    stage: redactString(input.stage, sensitiveValues),
    message: redactString(
      input.message ?? defaultMessage(input.code),
      sensitiveValues,
    ),
    platform,
    nextAction: redactString(input.nextAction, sensitiveValues),
  };
  if (input.expected !== undefined) {
    diagnostic.expected = redactDiagnosticValue(
      input.expected,
      sensitiveValues,
    );
  }
  if (input.observed !== undefined) {
    diagnostic.observed = redactDiagnosticValue(
      input.observed,
      sensitiveValues,
    );
  }
  if (input.executablePath !== undefined) {
    diagnostic.executablePath = redactString(
      input.executablePath,
      sensitiveValues,
    );
  }
  if (input.method !== undefined) diagnostic.method = input.method;
  if (input.requestId !== undefined) diagnostic.requestId = input.requestId;
  if (input.stderr !== undefined) {
    diagnostic.stderr = redactString(input.stderr, sensitiveValues);
  }
  return diagnostic;
}

export function transportError(input: DiagnosticInput): TransportError {
  return new TransportError(createTransportDiagnostic(input));
}

export function asTransportError(
  error: unknown,
  fallback: DiagnosticInput,
): TransportError {
  if (error instanceof TransportError) return error;
  return transportError({
    ...fallback,
    observed: {
      ...(
        fallback.observed !== null && typeof fallback.observed === "object"
          ? fallback.observed as Record<string, unknown>
          : {}
      ),
      errorType: error instanceof Error ? error.name : typeof error,
    },
  });
}

function defaultMessage(code: TransportDiagnosticCode): string {
  const messages: Record<TransportDiagnosticCode, string> = {
    PROCESS_SPAWN_FAILED: "the child process could not be started",
    PROCESS_EXITED: "the child process exited before the transport closed",
    STREAM_FAILED: "a child process stream failed",
    FRAME_TOO_LARGE: "a stdout frame exceeded the configured byte limit",
    INCOMPLETE_FRAME: "stdout ended with an incomplete JSONL frame",
    UTF8_INVALID: "a stdout frame was not strict UTF-8",
    JSON_INVALID: "a stdout frame was not one JSON value",
    ENVELOPE_INVALID: "a stdout JSON value was not a protocol envelope",
    SCHEMA_INVALID: "a protocol envelope failed its pinned schema",
    UNKNOWN_METHOD: "the exact-version protocol does not contain this method",
    UNKNOWN_SERVER_REQUEST: "an unknown server request was rejected",
    CORRELATION_UNKNOWN_ID: "a response did not match a pending request",
    CORRELATION_DUPLICATE_ID: "a response settled a request more than once",
    QUEUE_OVERFLOW: "the bounded server-message queue overflowed",
    REQUEST_TIMEOUT: "a pending protocol request exceeded its deadline",
    WRITE_FAILED: "a serialized child stdin write failed",
    INITIALIZE_DUPLICATE: "initialize may be requested only once",
    INITIALIZATION_REQUIRED: "initialize must succeed before this method",
    CLIENT_CLOSED: "the JSONL client is already closed",
    EOF_WITH_PENDING: "stdout ended while requests were still pending",
    CLOSE_FAILED: "the child process did not close cleanly",
    PLATFORM_UNSUPPORTED:
      "the shutdown boundary is unavailable on this platform",
    UNSAFE_PROCESS_GROUP:
      "the owned process-group identity could not be verified safely",
    GRACEFUL_SHUTDOWN_TIMEOUT:
      "the child did not exit within the graceful shutdown bound",
    TERMINATE_TIMEOUT:
      "the process group did not exit within the terminate bound",
    FORCE_TIMEOUT:
      "the process group did not exit within the force-termination bound",
    DESCENDANT_LEAK:
      "one or more observed descendant processes remain after shutdown",
    TRACKER_UNAVAILABLE: "a race-closing descendant tracker is unavailable",
    TRACKER_LOST: "the descendant tracker lost lineage events",
    TRACKER_OVERFLOWED:
      "the descendant tracker overflowed before shutdown completed",
    CONTAINMENT_UNPROVEN: "escaped-descendant containment could not be proven",
  };
  return messages[code];
}
