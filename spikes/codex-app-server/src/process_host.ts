import {
  asTransportError,
  createTransportDiagnostic,
  redactDiagnosticValue,
  TransportError,
} from "./diagnostics.ts";

export type StderrCapture = {
  totalBytes: number;
  retainedByteCount: number;
  retainedText: string;
};

export type ProcessCloseResult = {
  childExit: Deno.CommandStatus;
  stderr: StderrCapture;
};

export type SpawnProcessHostOptions = {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  maxStderrBytes: number;
};

export interface ProcessHost {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  readonly stderrCapture: Promise<StderrCapture>;
  close(): Promise<ProcessCloseResult>;
}

class OwnedProcessHost implements ProcessHost {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  readonly stderrCapture: Promise<StderrCapture>;
  #closePromise?: Promise<ProcessCloseResult>;
  #stderrController?: ReadableStreamDefaultController<Uint8Array>;

  constructor(
    private readonly child: Deno.ChildProcess,
    private readonly options: SpawnProcessHostOptions,
  ) {
    this.pid = child.pid;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.status = child.status;
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#stderrController = controller;
      },
      cancel: () => {
        this.#stderrController = undefined;
      },
    }, { highWaterMark: 1 });
    this.stderrCapture = this.#drainStderr(child.stderr);
  }

  async #drainStderr(
    stream: ReadableStream<Uint8Array>,
  ): Promise<StderrCapture> {
    let totalBytes = 0;
    let retained: Uint8Array<ArrayBufferLike> = new Uint8Array();
    try {
      for await (const chunk of stream) {
        totalBytes += chunk.byteLength;
        retained = appendBoundedTail(
          retained,
          chunk,
          this.options.maxStderrBytes,
        );
        if (
          this.#stderrController &&
          (this.#stderrController.desiredSize ?? 0) > 0
        ) {
          this.#stderrController.enqueue(chunk.slice());
        }
      }
      this.#stderrController?.close();
      this.#stderrController = undefined;
      const sensitiveValues = Object.entries(this.options.env)
        .filter(([key]) =>
          /(?:authorization|cookie|credential|password|secret|session|token|api[_-]?key)/i
            .test(key)
        )
        .map(([, value]) => value);
      const retainedText = redactDiagnosticValue(
        new TextDecoder().decode(retained),
        sensitiveValues,
      );
      return {
        totalBytes,
        retainedByteCount: retained.byteLength,
        retainedText: String(retainedText),
      };
    } catch (error) {
      const diagnostic = createTransportDiagnostic({
        code: "STREAM_FAILED",
        stage: "process.stderr",
        executablePath: this.options.executable,
        observed: {
          stream: "stderr",
          errorType: error instanceof Error ? error.name : typeof error,
        },
        nextAction: "inspect the child process and retry the compatibility run",
      });
      this.#stderrController?.error(new TransportError(diagnostic));
      this.#stderrController = undefined;
      throw new TransportError(diagnostic);
    }
  }

  close(): Promise<ProcessCloseResult> {
    if (!this.#closePromise) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<ProcessCloseResult> {
    try {
      try {
        await this.stdin.getWriter().close();
      } catch (error) {
        if (
          !(error instanceof TypeError) &&
          !(error instanceof Deno.errors.BrokenPipe)
        ) {
          throw error;
        }
      }
      const [childExit, stderr] = await Promise.all([
        this.status,
        this.stderrCapture,
      ]);
      return { childExit, stderr };
    } catch (error) {
      throw asTransportError(error, {
        code: "CLOSE_FAILED",
        stage: "process.close",
        executablePath: this.options.executable,
        nextAction:
          "terminate the child safely and inspect the close diagnostic",
      });
    }
  }
}

export function spawnProcessHost(
  options: SpawnProcessHostOptions,
): ProcessHost {
  if (
    !Number.isSafeInteger(options.maxStderrBytes) || options.maxStderrBytes <= 0
  ) {
    throw new TypeError("maxStderrBytes must be a positive safe integer");
  }
  try {
    const child = new Deno.Command(options.executable, {
      args: [...options.args],
      cwd: options.cwd,
      env: { ...options.env },
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    return new OwnedProcessHost(child, options);
  } catch (error) {
    throw asTransportError(error, {
      code: "PROCESS_SPAWN_FAILED",
      stage: "process.spawn",
      executablePath: options.executable,
      expected: { args: options.args, cwd: options.cwd },
      nextAction:
        "verify the executable, working directory, and scoped permissions",
    });
  }
}

function appendBoundedTail(
  retained: Uint8Array,
  chunk: Uint8Array,
  limit: number,
): Uint8Array {
  if (chunk.byteLength >= limit) return chunk.slice(chunk.byteLength - limit);
  const keep = Math.min(retained.byteLength, limit - chunk.byteLength);
  const result = new Uint8Array(keep + chunk.byteLength);
  if (keep > 0) {
    result.set(retained.subarray(retained.byteLength - keep), 0);
  }
  result.set(chunk, keep);
  return result;
}
