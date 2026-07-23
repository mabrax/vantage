import type { TransportDiagnostic } from "./diagnostics.ts";

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
