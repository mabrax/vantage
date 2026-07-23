import {
  createTransportDiagnostic,
  type TransportDiagnostic,
  type TransportDiagnosticCode,
  TransportError,
} from "./diagnostics.ts";
import {
  containmentBlockerCode,
  type ContainmentCapabilityEvidence,
  DarwinSnapshotProcessTree,
  type LineageEvent,
  type OwnedProcessIdentity,
  type ProcessTreeObservation,
} from "./process_tree_darwin.ts";

export type ShutdownBounds = {
  gracefulExitMs: number;
  terminateExitMs: number;
  forceExitMs: number;
};

export type ShutdownSignal =
  | "stdin-close"
  | "SIGTERM"
  | "SIGKILL";

export type ShutdownTimings = {
  startedAtMs: number;
  stdinClosedAtMs?: number;
  directExitAtMs?: number;
  completedAtMs: number;
  totalMs: number;
};

export type ShutdownEvidence = {
  rootIdentity: OwnedProcessIdentity;
  observedPids: number[];
  lineageEvents: LineageEvent[];
  signalPath: ShutdownSignal[];
  timedOutStages: Array<"graceful" | "terminate" | "force">;
  directExit?: Deno.CommandStatus;
  drains: {
    stdoutCompleted: boolean;
    stderrCompleted: boolean;
  };
  timings: ShutdownTimings;
  remainingPids: number[];
  noObservedDescendantsRemain: boolean;
  containmentCapability: ContainmentCapabilityEvidence;
  escapedDescendantContainmentProven: false;
  diagnostics: TransportDiagnostic[];
};

export type ShutdownPreparationHooks = {
  stopNewWork?: () => void | Promise<void>;
  settlePending?: () => void | Promise<void>;
  interruptActiveTurn?: () => void | Promise<void>;
};

export type ShutdownControllerOptions = {
  identity: OwnedProcessIdentity;
  processTree: DarwinSnapshotProcessTree;
  bounds: ShutdownBounds;
  status: Promise<Deno.CommandStatus>;
  stdoutDrained: Promise<void>;
  stderrDrained: Promise<unknown>;
  closeStdin: () => Promise<void>;
} & ShutdownPreparationHooks;

export class ShutdownError extends TransportError {
  constructor(
    diagnostic: TransportDiagnostic,
    public readonly evidence: ShutdownEvidence,
  ) {
    super(diagnostic);
    this.name = "ShutdownError";
  }
}

export class ShutdownController {
  #closePromise?: Promise<ShutdownEvidence>;

  constructor(private readonly options: ShutdownControllerOptions) {
    validateBounds(options.bounds);
    if (
      options.processTree.identity.rootPid !== options.identity.rootPid ||
      options.processTree.identity.processGroupId !==
        options.identity.processGroupId ||
      options.processTree.identity.sessionId !== options.identity.sessionId
    ) {
      throw new TypeError("process tree identity must match shutdown identity");
    }
  }

  close(): Promise<ShutdownEvidence> {
    if (!this.#closePromise) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<ShutdownEvidence> {
    const startedAtMs = performance.now();
    const signalPath: ShutdownSignal[] = [];
    const timedOutStages: ShutdownEvidence["timedOutStages"] = [];
    const diagnostics: TransportDiagnostic[] = [];
    let directExit: Deno.CommandStatus | undefined;
    let directExitAtMs: number | undefined;
    let stdoutDrainCompleted = false;
    let stderrDrainCompleted = false;
    let observation: ProcessTreeObservation | undefined;
    let strongestFailure:
      | { code: TransportDiagnosticCode; stage: string; nextAction: string }
      | undefined;

    const recordFailure = (
      code: TransportDiagnosticCode,
      stage: string,
      nextAction: string,
      observed?: unknown,
    ) => {
      const diagnostic = createTransportDiagnostic({
        code,
        stage,
        expected: {
          rootIdentity: this.options.identity,
          bounds: this.options.bounds,
        },
        observed,
        nextAction,
      });
      diagnostics.push(diagnostic);
      if (
        !strongestFailure ||
        failureRank(code) > failureRank(strongestFailure.code)
      ) {
        strongestFailure = { code, stage, nextAction };
      }
    };

    const observe = async () => {
      try {
        observation = await this.options.processTree.observe();
      } catch (error) {
        recordFailure(
          "STREAM_FAILED",
          "shutdown.snapshot",
          "retain the compatibility blocker and restore process inspection",
          { errorType: error instanceof Error ? error.name : typeof error },
        );
      }
    };

    const awaitStatus = async (
      timeoutMs: number,
    ): Promise<Deno.CommandStatus | undefined> => {
      const result = await settleWithin(this.options.status, timeoutMs);
      if (result.completed) {
        if (result.error !== undefined) {
          recordFailure(
            "CLOSE_FAILED",
            "shutdown.status",
            "inspect the direct child status failure and retry",
            {
              errorType: result.error instanceof Error
                ? result.error.name
                : typeof result.error,
            },
          );
          return undefined;
        }
        directExitAtMs ??= performance.now();
        return result.value;
      }
      return undefined;
    };

    try {
      const preparationDeadline = startedAtMs +
        this.options.bounds.gracefulExitMs;
      await invokeCleanupStep(
        "stop-new-work",
        this.options.stopNewWork,
        Math.max(0, preparationDeadline - performance.now()),
        recordFailure,
      );
      await invokeCleanupStep(
        "settle-pending",
        this.options.settlePending,
        Math.max(0, preparationDeadline - performance.now()),
        recordFailure,
      );
      await invokeCleanupStep(
        "interrupt-active-turn",
        this.options.interruptActiveTurn,
        Math.max(0, preparationDeadline - performance.now()),
        recordFailure,
      );
      await observe();

      try {
        await this.options.closeStdin();
      } catch (error) {
        if (
          !(error instanceof TypeError) &&
          !(error instanceof Deno.errors.BrokenPipe)
        ) {
          recordFailure(
            "CLOSE_FAILED",
            "shutdown.stdin",
            "continue process cleanup and inspect the stdin close failure",
            { errorType: error instanceof Error ? error.name : typeof error },
          );
        }
      }
      signalPath.push("stdin-close");
      const stdinClosedAtMs = performance.now();

      directExit = await awaitStatus(this.options.bounds.gracefulExitMs);
      if (!directExit) {
        timedOutStages.push("graceful");
        diagnostics.push(createTransportDiagnostic({
          code: "GRACEFUL_SHUTDOWN_TIMEOUT",
          stage: "shutdown.graceful",
          expected: { timeoutMs: this.options.bounds.gracefulExitMs },
          observed: { rootIdentity: this.options.identity },
          nextAction:
            "escalate only after re-verifying the owned process group",
        }));
        await observe();
        try {
          await this.options.processTree.signalGroup("SIGTERM");
          signalPath.push("SIGTERM");
        } catch (error) {
          recordFailure(
            error instanceof TransportError
              ? error.code
              : "UNSAFE_PROCESS_GROUP",
            "shutdown.terminate.signal",
            "do not signal an unverifiable negative PID; retain the compatibility blocker",
            error instanceof TransportError ? error.diagnostic.observed : {
              errorType: error instanceof Error ? error.name : typeof error,
            },
          );
        }
        directExit = await awaitStatus(this.options.bounds.terminateExitMs);
      }

      if (!directExit) {
        timedOutStages.push("terminate");
        diagnostics.push(createTransportDiagnostic({
          code: "TERMINATE_TIMEOUT",
          stage: "shutdown.terminate",
          expected: { timeoutMs: this.options.bounds.terminateExitMs },
          observed: { rootIdentity: this.options.identity },
          nextAction:
            "force termination only after re-verifying the owned process group",
        }));
        await observe();
        try {
          await this.options.processTree.signalGroup("SIGKILL");
          signalPath.push("SIGKILL");
        } catch (error) {
          recordFailure(
            error instanceof TransportError
              ? error.code
              : "UNSAFE_PROCESS_GROUP",
            "shutdown.force.signal",
            "do not signal an unverifiable negative PID; retain the compatibility blocker",
            error instanceof TransportError ? error.diagnostic.observed : {
              errorType: error instanceof Error ? error.name : typeof error,
            },
          );
        }
        directExit = await awaitStatus(this.options.bounds.forceExitMs);
      }

      if (!directExit) {
        timedOutStages.push("force");
        recordFailure(
          "FORCE_TIMEOUT",
          "shutdown.force",
          "inspect and terminate the remaining owned processes before retrying",
          { rootIdentity: this.options.identity },
        );
      }

      const drainResults = await Promise.all([
        settleWithin(
          this.options.stdoutDrained,
          this.options.bounds.forceExitMs,
        ),
        settleWithin(
          this.options.stderrDrained,
          this.options.bounds.forceExitMs,
        ),
        settleWithin(this.options.status, this.options.bounds.forceExitMs),
      ]);
      for (const [index, result] of drainResults.entries()) {
        if (!result.completed) {
          recordFailure(
            index === 2 ? "FORCE_TIMEOUT" : "STREAM_FAILED",
            index === 0
              ? "shutdown.stdout-drain"
              : index === 1
              ? "shutdown.stderr-drain"
              : "shutdown.status",
            "the bounded drain/status wait expired; inspect and terminate every remaining process",
            { timeoutMs: this.options.bounds.forceExitMs },
          );
        } else if (result.error !== undefined) {
          recordFailure(
            "STREAM_FAILED",
            index === 0
              ? "shutdown.stdout-drain"
              : index === 1
              ? "shutdown.stderr-drain"
              : "shutdown.status",
            "inspect the failed drain while preserving the completed cleanup evidence",
            {
              errorType: result.error instanceof Error
                ? result.error.name
                : typeof result.error,
            },
          );
        }
      }
      stdoutDrainCompleted = drainResults[0].completed &&
        drainResults[0].error === undefined;
      stderrDrainCompleted = drainResults[1].completed &&
        drainResults[1].error === undefined;
      if (
        !directExit && drainResults[2]?.completed &&
        drainResults[2].error === undefined
      ) {
        directExit = drainResults[2].value as Deno.CommandStatus;
        directExitAtMs ??= performance.now();
      }
      await observe();

      if (observation && !observation.noObservedDescendantsRemain) {
        recordFailure(
          "DESCENDANT_LEAK",
          "shutdown.final-snapshot",
          "terminate every remaining PID and keep the compatibility pair a candidate",
          {
            snapshotEvidence: {
              observedPids: observation.observedPids,
              remainingPids: observation.remainingPids,
            },
            proofCapabilityEvidence: observation.capability,
          },
        );
      }
      const capabilityBlocker = containmentBlockerCode(
        this.options.processTree.capability,
      );
      recordFailure(
        capabilityBlocker,
        "shutdown.containment-capability",
        "provide a pre-exec, continuously covering lineage facility before making a compatibility claim",
        {
          proofCapabilityEvidence: this.options.processTree.capability,
        },
      );
      recordFailure(
        "CONTAINMENT_UNPROVEN",
        "shutdown.containment-proof",
        "keep the compatibility pair a candidate until immediate escaped-descendant containment is proven",
        {
          snapshotEvidence: observation
            ? {
              noObservedDescendantsRemain:
                observation.noObservedDescendantsRemain,
              observedPids: observation.observedPids,
              remainingPids: observation.remainingPids,
            }
            : undefined,
          proofCapabilityEvidence: this.options.processTree.capability,
        },
      );

      const completedAtMs = performance.now();
      const evidence: ShutdownEvidence = {
        rootIdentity: { ...this.options.identity },
        observedPids: observation?.observedPids ?? [
          this.options.identity.rootPid,
        ],
        lineageEvents: observation?.lineageEvents ?? [],
        signalPath,
        timedOutStages,
        ...(directExit ? { directExit } : {}),
        drains: {
          stdoutCompleted: stdoutDrainCompleted,
          stderrCompleted: stderrDrainCompleted,
        },
        timings: {
          startedAtMs,
          stdinClosedAtMs,
          ...(directExitAtMs === undefined ? {} : { directExitAtMs }),
          completedAtMs,
          totalMs: completedAtMs - startedAtMs,
        },
        remainingPids: observation?.remainingPids ?? [
          this.options.identity.rootPid,
        ],
        noObservedDescendantsRemain: observation?.noObservedDescendantsRemain ??
          false,
        containmentCapability: this.options.processTree.capability,
        escapedDescendantContainmentProven: false,
        diagnostics,
      };
      const selected = strongestFailure ?? {
        code: "CONTAINMENT_UNPROVEN" as const,
        stage: "shutdown.containment-proof",
        nextAction:
          "keep the compatibility pair a candidate until escaped-descendant containment is proven",
      };
      const diagnostic = diagnostics.find((candidate) =>
        candidate.code === selected.code && candidate.stage === selected.stage
      ) ?? createTransportDiagnostic(selected);
      throw new ShutdownError(diagnostic, evidence);
    } catch (error) {
      if (error instanceof ShutdownError) throw error;
      const completedAtMs = performance.now();
      const fallbackObservation = observation;
      const evidence: ShutdownEvidence = {
        rootIdentity: { ...this.options.identity },
        observedPids: fallbackObservation?.observedPids ?? [
          this.options.identity.rootPid,
        ],
        lineageEvents: fallbackObservation?.lineageEvents ?? [],
        signalPath,
        timedOutStages,
        ...(directExit ? { directExit } : {}),
        drains: {
          stdoutCompleted: stdoutDrainCompleted,
          stderrCompleted: stderrDrainCompleted,
        },
        timings: {
          startedAtMs,
          ...(directExitAtMs === undefined ? {} : { directExitAtMs }),
          completedAtMs,
          totalMs: completedAtMs - startedAtMs,
        },
        remainingPids: fallbackObservation?.remainingPids ?? [
          this.options.identity.rootPid,
        ],
        noObservedDescendantsRemain:
          fallbackObservation?.noObservedDescendantsRemain ?? false,
        containmentCapability: this.options.processTree.capability,
        escapedDescendantContainmentProven: false,
        diagnostics,
      };
      const diagnostic = createTransportDiagnostic({
        code: "CLOSE_FAILED",
        stage: "shutdown.close",
        observed: {
          errorType: error instanceof Error ? error.name : typeof error,
          snapshotEvidence: {
            observedPids: evidence.observedPids,
            remainingPids: evidence.remainingPids,
          },
          proofCapabilityEvidence: evidence.containmentCapability,
        },
        nextAction:
          "inspect the bounded shutdown evidence and retain the compatibility blocker",
      });
      evidence.diagnostics.push(diagnostic);
      throw new ShutdownError(diagnostic, evidence);
    }
  }
}

function validateBounds(bounds: ShutdownBounds): void {
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<
  | { completed: false }
  | { completed: true; value?: T; error?: unknown }
> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ completed: true as const, value }),
        (error) => ({ completed: true as const, error }),
      ),
      new Promise<{ completed: false }>((resolve) => {
        timeout = setTimeout(() => resolve({ completed: false }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function invokeCleanupStep(
  name: "stop-new-work" | "settle-pending" | "interrupt-active-turn",
  callback: (() => void | Promise<void>) | undefined,
  timeoutMs: number,
  recordFailure: (
    code: TransportDiagnosticCode,
    stage: string,
    nextAction: string,
    observed?: unknown,
  ) => void,
): Promise<void> {
  if (!callback) return;
  const result = await settleWithin(
    Promise.resolve().then(callback),
    timeoutMs,
  );
  if (!result.completed) {
    recordFailure(
      "GRACEFUL_SHUTDOWN_TIMEOUT",
      `shutdown.prepare.${name}`,
      "continue bounded process cleanup and keep the compatibility pair blocked",
      { timeoutMs },
    );
  } else if (result.error !== undefined) {
    recordFailure(
      "CLOSE_FAILED",
      `shutdown.prepare.${name}`,
      "continue bounded process cleanup and inspect the preparation failure",
      {
        errorType: result.error instanceof Error
          ? result.error.name
          : typeof result.error,
      },
    );
  }
}

function failureRank(code: TransportDiagnosticCode): number {
  switch (code) {
    case "FORCE_TIMEOUT":
      return 50;
    case "UNSAFE_PROCESS_GROUP":
      return 40;
    case "DESCENDANT_LEAK":
      return 30;
    case "STREAM_FAILED":
    case "CLOSE_FAILED":
      return 20;
    case "TRACKER_LOST":
    case "TRACKER_OVERFLOWED":
    case "TRACKER_UNAVAILABLE":
    case "CONTAINMENT_UNPROVEN":
      return 10;
    default:
      return 0;
  }
}
