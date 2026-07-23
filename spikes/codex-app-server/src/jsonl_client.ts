import {
  asTransportError,
  TransportError,
  transportError,
} from "./diagnostics.ts";
import type { ProcessCloseResult, ProcessHost } from "./process_host.ts";
import {
  ProtocolValidator,
  SchemaValidationError,
} from "./protocol_validation.ts";
import {
  type ClassifiedEnvelope,
  type RequestId,
  type ServerProtocolRecord,
  TranscriptRecorder,
} from "./transcript.ts";

export type JsonlLimits = {
  maxStdoutLineBytes: number;
  maxQueueMessages: number;
  maxQueueBytes: number;
  requestTimeoutMs: number;
};

export type JsonlClientOptions = {
  host: ProcessHost;
  validator: ProtocolValidator;
  recorder: TranscriptRecorder;
  limits: JsonlLimits;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type QueuedMessage = {
  envelope: Extract<
    ClassifiedEnvelope,
    { kind: "server-notification" | "server-request" }
  >;
  byteLength: number;
};

type QueueWaiter = {
  resolve: (value: QueuedMessage | undefined) => void;
  reject: (reason: unknown) => void;
};

export class ProtocolResponseError extends Error {
  constructor(
    public readonly requestId: RequestId,
    public readonly protocolError: unknown,
  ) {
    super(`protocol request ${String(requestId)} returned an error`);
    this.name = "ProtocolResponseError";
  }
}

export class JsonlClient {
  readonly host: ProcessHost;
  readonly validator: ProtocolValidator;
  readonly recorder: TranscriptRecorder;
  readonly limits: JsonlLimits;
  readonly done: Promise<void>;

  #resolveDone!: () => void;
  #rejectDone!: (reason: unknown) => void;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #writeTail: Promise<void> = Promise.resolve();
  #pending = new Map<RequestId, PendingRequest>();
  #settledResponseIds = new Set<RequestId>();
  #pendingServerRequests = new Map<RequestId, string>();
  #nextRequestId = 1;
  #initializeSent = false;
  #initialized = false;
  #closing = false;
  #closed = false;
  #readerEnded = false;
  #failure?: TransportError;
  #closePromise?: Promise<ProcessCloseResult>;
  #queue: QueuedMessage[] = [];
  #queueBytes = 0;
  #queueWaiters: QueueWaiter[] = [];

  private constructor(options: JsonlClientOptions) {
    this.host = options.host;
    this.validator = options.validator;
    this.recorder = options.recorder;
    this.limits = options.limits;
    validateLimits(this.limits);
    this.#writer = this.host.stdin.getWriter();
    this.done = new Promise<void>((resolve, reject) => {
      this.#resolveDone = resolve;
      this.#rejectDone = reject;
    });
    // The failure remains observable through `done`, requests, and `messages()`.
    // Attaching a handler here prevents a background reader failure from becoming
    // an unrelated unhandled-rejection report before the caller reaches cleanup.
    this.done.catch(() => {});
    void this.#readLoop();
  }

  static connect(options: JsonlClientOptions): JsonlClient {
    return new JsonlClient(options);
  }

  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  get queueDepth(): { messages: number; bytes: number } {
    return { messages: this.#queue.length, bytes: this.#queueBytes };
  }

  get failure(): TransportError | undefined {
    return this.#failure;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.#assertCanWrite(method);
    if (method === "initialize") {
      if (this.#initializeSent) {
        throw transportError({
          code: "INITIALIZE_DUPLICATE",
          stage: "client.request",
          method,
          nextAction:
            "reuse the initialized connection or start a new connection",
        });
      }
      this.#initializeSent = true;
    } else if (!this.#initialized) {
      throw transportError({
        code: "INITIALIZATION_REQUIRED",
        stage: "client.request",
        method,
        expected: "a successful initialize response",
        nextAction: "initialize this connection before sending the method",
      });
    }

    const id = this.#nextRequestId++;
    const envelope: Record<string, unknown> = { id, method };
    if (params !== undefined) envelope.params = params;

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        const error = transportError({
          code: "REQUEST_TIMEOUT",
          stage: "client.request",
          method,
          requestId: id,
          expected: { timeoutMs: this.limits.requestTimeoutMs },
          nextAction:
            "close the failed connection and inspect the child status",
        });
        reject(error);
        this.#fail(error);
      }, this.limits.requestTimeoutMs);
      this.#pending.set(id, {
        method,
        resolve,
        reject,
        timeout,
      });
      this.#enqueueEnvelope(envelope, "client-request").catch((error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.#assertCanWrite(method);
    if (!this.#initialized) {
      throw transportError({
        code: "INITIALIZATION_REQUIRED",
        stage: "client.notify",
        method,
        expected: "a successful initialize response",
        nextAction:
          "initialize this connection before sending the notification",
      });
    }
    const envelope: Record<string, unknown> = { method };
    if (params !== undefined) envelope.params = params;
    await this.#enqueueEnvelope(envelope, "client-notification");
  }

  async respondToServerRequest(
    id: RequestId,
    result: unknown,
  ): Promise<void> {
    this.#assertCanWrite("<server-request-response>");
    const method = this.#pendingServerRequests.get(id);
    if (!method) {
      throw transportError({
        code: "CORRELATION_UNKNOWN_ID",
        stage: "client.server-request-response",
        requestId: id,
        nextAction: "respond only once to a request owned by this connection",
      });
    }
    const envelope = { id, result };
    try {
      this.validator.validateResponseEnvelope(
        "server-request",
        method,
        envelope,
      );
    } catch (error) {
      throw schemaTransportError(
        error,
        "client.server-request-response",
        method,
        id,
      );
    }
    this.#pendingServerRequests.delete(id);
    await this.#enqueueRawResponse(envelope);
  }

  async *messages(): AsyncIterable<
    Extract<
      ClassifiedEnvelope,
      { kind: "server-notification" | "server-request" }
    >
  > {
    while (true) {
      const queued = await this.#nextQueuedMessage();
      if (!queued) return;
      yield queued.envelope;
    }
  }

  close(): Promise<ProcessCloseResult> {
    if (!this.#closePromise) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<ProcessCloseResult> {
    this.#closing = true;
    this.#rejectAllPending(
      transportError({
        code: "CLIENT_CLOSED",
        stage: "client.close",
        nextAction: "start a new connection for additional protocol work",
      }),
    );
    try {
      await this.#writeTail;
      try {
        await this.#writer.close();
      } catch (error) {
        if (
          !(error instanceof TypeError) &&
          !(error instanceof Deno.errors.BrokenPipe)
        ) {
          throw error;
        }
      } finally {
        this.#writer.releaseLock();
      }
      const result = await this.host.close();
      try {
        await this.done;
      } catch {
        // The retained reader diagnostic is the run failure. Close still returns
        // process evidence so every failure path can finish cleanup.
      }
      this.#closed = true;
      this.#finishQueue();
      return result;
    } catch (error) {
      this.#closed = true;
      const failure = asTransportError(error, {
        code: "CLOSE_FAILED",
        stage: "client.close",
        nextAction:
          "inspect process status and the retained stream diagnostics",
      });
      this.#fail(failure);
      this.#rejectQueueWaiters(failure);
      throw failure;
    }
  }

  #assertCanWrite(method: string): void {
    if (this.#closing || this.#closed) {
      throw transportError({
        code: "CLIENT_CLOSED",
        stage: "client.write",
        method,
        nextAction: "start a new connection before sending more work",
      });
    }
    if (this.#failure) throw this.#failure;
  }

  #enqueueEnvelope(
    envelope: Record<string, unknown>,
    direction: "client-request" | "client-notification",
  ): Promise<void> {
    return this.#serializeWrite(async () => {
      const method = String(envelope.method);
      try {
        this.validator.validateEnvelope(direction, envelope);
      } catch (error) {
        throw schemaTransportError(
          error,
          "client.schema",
          method,
          typeof envelope.id === "number" || typeof envelope.id === "string"
            ? envelope.id
            : undefined,
        );
      }
      const bytes = encodeLine(envelope);
      this.recorder.appendClient(
        {
          method,
          id: typeof envelope.id === "number" ||
              typeof envelope.id === "string"
            ? envelope.id
            : undefined,
          params: envelope.params,
        },
        bytes.byteLength,
      );
      try {
        await this.#writer.write(bytes);
      } catch (error) {
        throw asTransportError(error, {
          code: "WRITE_FAILED",
          stage: "client.write",
          method,
          requestId: typeof envelope.id === "number" ||
              typeof envelope.id === "string"
            ? envelope.id
            : undefined,
          nextAction: "close the connection and inspect child process status",
        });
      }
    });
  }

  #enqueueRawResponse(
    envelope: { id: RequestId; result?: unknown; error?: unknown },
  ): Promise<void> {
    return this.#serializeWrite(async () => {
      const bytes = encodeLine(envelope);
      this.recorder.appendClientResponse(envelope, bytes.byteLength);
      try {
        await this.#writer.write(bytes);
      } catch (error) {
        throw asTransportError(error, {
          code: "WRITE_FAILED",
          stage: "client.server-request-response",
          requestId: envelope.id,
          nextAction: "close the connection and inspect child process status",
        });
      }
    });
  }

  #serializeWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.#writeTail.then(async () => {
      if (this.#failure) throw this.#failure;
      if (this.#closing || this.#closed) {
        throw transportError({
          code: "CLIENT_CLOSED",
          stage: "client.write",
          nextAction: "start a new connection before sending more work",
        });
      }
      await operation();
    });
    this.#writeTail = result.then(
      () => {},
      (error) => {
        this.#fail(asTransportError(error, {
          code: "WRITE_FAILED",
          stage: "client.write",
          nextAction:
            "close the failed connection and inspect child process status",
        }));
      },
    );
    return result;
  }

  async #readLoop(): Promise<void> {
    const buffered = new Uint8Array(this.limits.maxStdoutLineBytes);
    let bufferedLength = 0;
    try {
      for await (const chunk of this.host.stdout) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const newline = chunk.indexOf(0x0a, offset);
          const segmentEnd = newline >= 0 ? newline : chunk.byteLength;
          const segmentLength = segmentEnd - offset;
          const frameLength = bufferedLength + segmentLength;
          if (frameLength > this.limits.maxStdoutLineBytes) {
            const error = transportError({
              code: "FRAME_TOO_LARGE",
              stage: "reader.framing",
              expected: { maxBytes: this.limits.maxStdoutLineBytes },
              observed: newline >= 0
                ? { frameBytes: frameLength }
                : { incompleteBytes: frameLength },
              nextAction:
                "close the incompatible server and inspect its output",
            });
            if (newline >= 0) {
              const record = this.recorder.appendServerFrame(frameLength);
              throw this.#recordFailure(record, error);
            }
            throw error;
          }

          buffered.set(chunk.subarray(offset, segmentEnd), bufferedLength);
          bufferedLength = frameLength;
          if (newline < 0) break;

          const record = this.recorder.appendServerFrame(bufferedLength);
          await this.#processFrame(
            buffered.subarray(0, bufferedLength),
            record,
          );
          bufferedLength = 0;
          offset = newline + 1;
        }
      }
      this.#readerEnded = true;
      if (bufferedLength > 0) {
        throw transportError({
          code: "INCOMPLETE_FRAME",
          stage: "reader.eof",
          observed: { incompleteBytes: bufferedLength },
          nextAction:
            "require the server to terminate every JSON object with a newline",
        });
      }
      if (this.#pending.size > 0) {
        throw transportError({
          code: "EOF_WITH_PENDING",
          stage: "reader.eof",
          observed: { pendingRequestIds: [...this.#pending.keys()] },
          nextAction:
            "inspect the child exit and do not retry requests automatically",
        });
      }
      if (!this.#closing) {
        throw transportError({
          code: "PROCESS_EXITED",
          stage: "reader.eof",
          nextAction:
            "inspect child status and start a new connection if appropriate",
        });
      }
      this.#resolveDone();
      this.#finishQueue();
    } catch (error) {
      this.#readerEnded = true;
      const failure = asTransportError(error, {
        code: "STREAM_FAILED",
        stage: "reader.stdout",
        nextAction:
          "close the failed connection and inspect child process status",
      });
      this.#fail(failure);
    }
  }

  #rejectQueueWaiters(error: unknown): void {
    for (const waiter of this.#queueWaiters.splice(0)) waiter.reject(error);
  }

  async #processFrame(
    frame: Uint8Array,
    record: ServerProtocolRecord,
  ): Promise<void> {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch (error) {
      throw this.#recordFailure(
        record,
        asTransportError(error, {
          code: "UTF8_INVALID",
          stage: "reader.utf8",
          observed: { frameBytes: frame.byteLength },
          nextAction: "require strict UTF-8 protocol output from the exact CLI",
        }),
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw this.#recordFailure(
        record,
        asTransportError(error, {
          code: "JSON_INVALID",
          stage: "reader.json",
          observed: { frameBytes: frame.byteLength },
          nextAction: "require exactly one JSON value in each stdout frame",
        }),
      );
    }

    let envelope: ClassifiedEnvelope;
    try {
      envelope = classifyEnvelope(value);
      this.recorder.classifyServerFrame(record, envelope);
    } catch (error) {
      throw this.#recordFailure(
        record,
        asTransportError(error, {
          code: "ENVELOPE_INVALID",
          stage: "reader.envelope",
          observed: { frameBytes: frame.byteLength },
          nextAction:
            "require a generated JSON-RPC response, notification, or request",
        }),
      );
    }

    if (envelope.kind === "response") {
      try {
        this.#handleResponse(envelope, value);
      } catch (error) {
        throw this.#recordFailure(
          record,
          asTransportError(error, {
            code: "SCHEMA_INVALID",
            stage: "reader.response",
            requestId: envelope.id,
            nextAction:
              "require one schema-valid response for a pending request",
          }),
        );
      }
      return;
    }

    if (!this.#initialized) {
      throw this.#recordFailure(
        record,
        transportError({
          code: "INITIALIZATION_REQUIRED",
          stage: "reader.initialization",
          method: envelope.method,
          requestId: envelope.kind === "server-request"
            ? envelope.id
            : undefined,
          expected: "a successful initialize response",
          nextAction: "require the server to wait for initialization",
        }),
      );
    }

    try {
      this.validator.validateEnvelope(
        envelope.kind === "server-notification"
          ? "server-notification"
          : "server-request",
        value,
      );
    } catch (error) {
      if (
        envelope.kind === "server-request" &&
        error instanceof SchemaValidationError &&
        error.code === "UNKNOWN_PROTOCOL_METHOD"
      ) {
        const methodNotFound = {
          id: envelope.id,
          error: { code: -32601, message: "Method not found" },
        };
        this.validator.validateErrorResponseEnvelope(methodNotFound);
        await this.#enqueueRawResponse(methodNotFound);
        throw this.#recordFailure(
          record,
          transportError({
            code: "UNKNOWN_SERVER_REQUEST",
            stage: "reader.schema",
            method: envelope.method,
            requestId: envelope.id,
            nextAction:
              "use only the pinned exact-version server-request surface",
          }),
        );
      }
      throw this.#recordFailure(
        record,
        schemaTransportError(
          error,
          "reader.schema",
          envelope.method,
          envelope.kind === "server-request" ? envelope.id : undefined,
        ),
      );
    }

    if (envelope.kind === "server-request") {
      if (this.#pendingServerRequests.has(envelope.id)) {
        throw this.#recordFailure(
          record,
          transportError({
            code: "CORRELATION_DUPLICATE_ID",
            stage: "reader.server-request",
            method: envelope.method,
            requestId: envelope.id,
            nextAction:
              "require connection-local server request IDs to be unique",
          }),
        );
      }
      this.#pendingServerRequests.set(envelope.id, envelope.method);
    }
    this.#enqueueMessage({ envelope, byteLength: frame.byteLength }, record);
  }

  #handleResponse(
    envelope: Extract<ClassifiedEnvelope, { kind: "response" }>,
    rawEnvelope: unknown,
  ): void {
    const pending = this.#pending.get(envelope.id);
    if (!pending) {
      const duplicate = this.#settledResponseIds.has(envelope.id);
      throw transportError({
        code: duplicate ? "CORRELATION_DUPLICATE_ID" : "CORRELATION_UNKNOWN_ID",
        stage: "reader.correlation",
        requestId: envelope.id,
        nextAction:
          "require each response to settle one pending request exactly once",
      });
    }
    try {
      this.validator.validateResponseEnvelope(
        "client-request",
        pending.method,
        rawEnvelope,
      );
    } catch (error) {
      throw schemaTransportError(
        error,
        "reader.response-schema",
        pending.method,
        envelope.id,
      );
    }
    this.#pending.delete(envelope.id);
    this.#settledResponseIds.add(envelope.id);
    clearTimeout(pending.timeout);
    if (pending.method === "initialize" && envelope.error === undefined) {
      this.#initialized = true;
    }
    if (envelope.error !== undefined) {
      pending.reject(new ProtocolResponseError(envelope.id, envelope.error));
    } else {
      pending.resolve(envelope.result);
    }
  }

  #enqueueMessage(
    message: QueuedMessage,
    record: ServerProtocolRecord,
  ): void {
    const observedMessages = this.#queue.length + 1;
    const observedBytes = this.#queueBytes + message.byteLength;
    if (
      observedMessages > this.limits.maxQueueMessages ||
      observedBytes > this.limits.maxQueueBytes
    ) {
      throw this.#recordFailure(
        record,
        transportError({
          code: "QUEUE_OVERFLOW",
          stage: "reader.queue",
          method: message.envelope.method,
          requestId: message.envelope.kind === "server-request"
            ? message.envelope.id
            : undefined,
          expected: {
            maxMessages: this.limits.maxQueueMessages,
            maxBytes: this.limits.maxQueueBytes,
          },
          observed: {
            messages: observedMessages,
            bytes: observedBytes,
          },
          nextAction:
            "fail the run without dropping or reordering the observed frame",
        }),
      );
    }
    const waiter = this.#queueWaiters.shift();
    if (waiter) {
      waiter.resolve(message);
      return;
    }
    this.#queue.push(message);
    this.#queueBytes += message.byteLength;
  }

  async #nextQueuedMessage(): Promise<QueuedMessage | undefined> {
    const queued = this.#queue.shift();
    if (queued) {
      this.#queueBytes -= queued.byteLength;
      return queued;
    }
    if (this.#failure) throw this.#failure;
    if (this.#closed || (this.#readerEnded && this.#closing)) return undefined;
    return await new Promise<QueuedMessage | undefined>((resolve, reject) => {
      this.#queueWaiters.push({ resolve, reject });
    });
  }

  #finishQueue(): void {
    if (this.#queue.length > 0) return;
    for (const waiter of this.#queueWaiters.splice(0)) {
      waiter.resolve(undefined);
    }
  }

  #recordFailure(
    record: ServerProtocolRecord,
    error: TransportError,
  ): TransportError {
    this.recorder.failServerFrame(record, error.diagnostic);
    return error;
  }

  #fail(error: TransportError): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#rejectAllPending(error);
    this.#rejectQueueWaiters(error);
    this.#rejectDone(error);
  }

  #rejectAllPending(error: unknown): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function validateLimits(limits: JsonlLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
}

function classifyEnvelope(value: unknown): ClassifiedEnvelope {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
  ) {
    throw new TypeError("protocol envelope must be an object");
  }
  const record = value as Record<string, unknown>;
  const hasId = typeof record.id === "string" ||
    (typeof record.id === "number" && Number.isSafeInteger(record.id));
  const hasResult = Object.hasOwn(record, "result");
  const hasError = Object.hasOwn(record, "error");
  const hasMethod = typeof record.method === "string";
  if (hasId && !hasMethod && hasResult !== hasError) {
    return {
      kind: "response",
      id: record.id as RequestId,
      ...(hasResult ? { result: record.result } : { error: record.error }),
    };
  }
  if (hasMethod && hasId && !hasResult && !hasError) {
    return {
      kind: "server-request",
      id: record.id as RequestId,
      method: record.method as string,
      params: record.params,
    };
  }
  if (hasMethod && !hasId && !hasResult && !hasError) {
    return {
      kind: "server-notification",
      method: record.method as string,
      params: record.params,
    };
  }
  throw new TypeError("ambiguous or incomplete protocol envelope");
}

function schemaTransportError(
  error: unknown,
  stage: string,
  method?: string,
  requestId?: RequestId,
): TransportError {
  const unknown = error instanceof SchemaValidationError &&
    error.code === "UNKNOWN_PROTOCOL_METHOD";
  return transportError({
    code: unknown ? "UNKNOWN_METHOD" : "SCHEMA_INVALID",
    stage,
    method,
    requestId,
    observed: {
      schemaCode: error instanceof SchemaValidationError
        ? error.code
        : error instanceof Error
        ? error.name
        : typeof error,
    },
    nextAction: unknown
      ? "use only methods in the pinned exact-version stable protocol"
      : "compare the envelope with the pinned generated schema",
  });
}

function encodeLine(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}
