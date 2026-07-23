import {
  asTransportError,
  createTransportDiagnostic,
  redactDiagnosticValue,
  TransportError,
} from "./diagnostics.ts";
import {
  captureOwnedProcessIdentity,
  DarwinSnapshotProcessTree,
  type OwnedProcessIdentity,
} from "./process_tree_darwin.ts";
import {
  type ShutdownBounds,
  ShutdownController,
  type ShutdownEvidence,
  type ShutdownPreparationHooks,
} from "./shutdown.ts";

export type StderrCapture = {
  totalBytes: number;
  retainedByteCount: number;
  retainedText: string;
};

export type ProcessCloseResult = {
  childExit: Deno.CommandStatus;
  stderr: StderrCapture;
  shutdown?: ShutdownEvidence;
};

export type SpawnProcessHostOptions = {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  maxStderrBytes: number;
};

export type SpawnShutdownProcessHostOptions = SpawnProcessHostOptions & {
  shutdownBounds: ShutdownBounds;
  shutdownHooks?: ShutdownPreparationHooks;
  sessionLauncher?: string;
};

export interface ProcessHost {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  readonly stderrCapture: Promise<StderrCapture>;
  readonly stdoutDrained?: Promise<void>;
  readonly ownedIdentity?: OwnedProcessIdentity;
  close(): Promise<ProcessCloseResult>;
}

class OwnedProcessHost implements ProcessHost {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  readonly stderrCapture: Promise<StderrCapture>;
  readonly stdoutDrained: Promise<void>;
  ownedIdentity?: OwnedProcessIdentity;
  #closePromise?: Promise<ProcessCloseResult>;
  #stderrController?: ReadableStreamDefaultController<Uint8Array>;
  #shutdownController?: ShutdownController;

  constructor(
    private readonly child: Deno.ChildProcess,
    private readonly options: SpawnProcessHostOptions,
  ) {
    this.pid = child.pid;
    this.stdin = child.stdin;
    this.status = child.status;
    const trackedStdout = trackReadable(child.stdout);
    this.stdout = trackedStdout.stream;
    this.stdoutDrained = trackedStdout.drained;
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

  attachShutdown(
    identity: OwnedProcessIdentity,
    bounds: ShutdownBounds,
    hooks: ShutdownPreparationHooks = {},
  ): void {
    if (this.#shutdownController) {
      throw new TypeError("shutdown controller is already attached");
    }
    this.ownedIdentity = identity;
    const processTree = new DarwinSnapshotProcessTree(identity);
    this.#shutdownController = new ShutdownController({
      identity,
      processTree,
      bounds,
      status: this.status,
      stdoutDrained: this.stdoutDrained,
      stderrDrained: this.stderrCapture,
      closeStdin: () => this.#closeStdin(),
      ...hooks,
    });
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
      if (this.#shutdownController) {
        const shutdown = await this.#shutdownController.close();
        const stderr = await this.stderrCapture;
        if (!shutdown.directExit) {
          throw new TypeError("shutdown completed without direct child status");
        }
        return {
          childExit: shutdown.directExit,
          stderr,
          shutdown,
        };
      }
      await this.#closeStdin();
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

  async #closeStdin(): Promise<void> {
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

const OWNED_SESSION_LAUNCHER = [
  "import os,sys",
  "os.setsid()",
  "os.execve(sys.argv[1], [sys.argv[1], *sys.argv[2:]], dict(os.environ))",
].join(";");

export async function spawnShutdownProcessHost(
  options: SpawnShutdownProcessHostOptions,
): Promise<ProcessHost> {
  if (!options.executable.startsWith("/")) {
    throw new TypeError(
      "shutdown process executable must be an absolute resolved path",
    );
  }
  const launcher = options.sessionLauncher ?? "/usr/bin/python3";
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(launcher, {
      args: [
        "-c",
        OWNED_SESSION_LAUNCHER,
        options.executable,
        ...options.args,
      ],
      cwd: options.cwd,
      env: { ...options.env },
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    throw asTransportError(error, {
      code: "PROCESS_SPAWN_FAILED",
      stage: "process.spawn-owned-session",
      executablePath: options.executable,
      expected: {
        args: options.args,
        cwd: options.cwd,
        sessionLauncher: launcher,
      },
      nextAction:
        "restore the owned-session launcher and scoped subprocess permissions",
    });
  }

  const host = new OwnedProcessHost(child, options);
  try {
    const identity = await waitForOwnedIdentity(
      child.pid,
      options.shutdownBounds.gracefulExitMs,
    );
    host.attachShutdown(
      identity,
      options.shutdownBounds,
      options.shutdownHooks,
    );
    return host;
  } catch (error) {
    try {
      await terminateSetupChild(
        child.pid,
        host,
        options.shutdownBounds.forceExitMs,
      );
    } catch (cleanupError) {
      throw asTransportError(cleanupError, {
        code: "FORCE_TIMEOUT",
        stage: "process.spawn-owned-session.cleanup",
        executablePath: options.executable,
        observed: { rootPid: child.pid },
        nextAction:
          "inspect and terminate the setup-failure child before retrying",
      });
    }
    throw asTransportError(error, {
      code: "UNSAFE_PROCESS_GROUP",
      stage: "process.spawn-owned-session",
      executablePath: options.executable,
      observed: { rootPid: child.pid },
      nextAction:
        "do not run child work without a verified positive root/session/group identity",
    });
  }
}

async function terminateSetupChild(
  rootPid: number,
  host: OwnedProcessHost,
  timeoutMs: number,
): Promise<void> {
  let killError: unknown;
  try {
    const output = await new Deno.Command("/bin/kill", {
      args: ["-KILL", "--", String(rootPid)],
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!output.success) {
      killError = new Error(new TextDecoder().decode(output.stderr));
    }
  } catch (error) {
    killError = error;
  }
  await host.stdout.cancel().catch(() => {});
  const joined = await settleProcessWithin(
    Promise.allSettled([
      host.status,
      host.stderrCapture,
      host.stdoutDrained,
    ]),
    timeoutMs,
  );
  if (!joined.completed) {
    throw new Error("setup-failure process joins exceeded the force bound");
  }
  const rejected = joined.value.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  if (killError && joined.value[0]?.status !== "fulfilled") throw killError;
}

async function settleProcessWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ completed: false } | { completed: true; value: T }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ completed: true as const, value })),
      new Promise<{ completed: false }>((resolve) => {
        timeout = setTimeout(() => resolve({ completed: false }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForOwnedIdentity(
  rootPid: number,
  timeoutMs: number,
): Promise<OwnedProcessIdentity> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      return await captureOwnedProcessIdentity(rootPid);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError ?? new Error("owned process identity was not observed");
}

function trackReadable(
  source: ReadableStream<Uint8Array>,
): { stream: ReadableStream<Uint8Array>; drained: Promise<void> } {
  const reader = source.getReader();
  let consumerCanceled = false;
  let drainSettled = false;
  let readTail: Promise<void> = Promise.resolve();
  let resolveDrained!: () => void;
  let rejectDrained!: (reason: unknown) => void;
  const drained = new Promise<void>((resolve, reject) => {
    resolveDrained = resolve;
    rejectDrained = reject;
  });
  // Keep a close-path stream failure observable without producing an unrelated
  // unhandled rejection before shutdown joins the drain.
  drained.catch(() => {});
  const settleDrained = (error?: unknown) => {
    if (drainSettled) return;
    drainSettled = true;
    try {
      reader.releaseLock();
    } catch {
      // A queued read still owns the lock and will settle the drain.
    }
    if (error === undefined) resolveDrained();
    else rejectDrained(error);
  };
  const readNext = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const result = readTail.then(() => reader.read());
    readTail = result.then(() => {}, () => {});
    return result;
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await readNext();
        if (result.done) {
          if (!consumerCanceled) controller.close();
          settleDrained();
        } else if (!consumerCanceled) {
          controller.enqueue(result.value);
        }
      } catch (error) {
        if (!consumerCanceled) controller.error(error);
        settleDrained(error);
      }
    },
    cancel() {
      consumerCanceled = true;
      // Do not make consumer failure wait for child exit: the protocol client
      // must be able to enter close while this owned background drain runs.
      void (async () => {
        try {
          while (!(await readNext()).done) {
            // Continue draining without retaining additional bytes.
          }
          settleDrained();
        } catch (error) {
          settleDrained(error);
        }
      })();
    },
  });
  return { stream, drained };
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
