import {
  deriveCoverageFromJournal,
  extractStableSurface,
  validateCoverageMembership,
} from "./coverage.ts";
import { ContractError } from "./config.ts";
import { TransportError } from "./diagnostics.ts";
import { verifyProtocol } from "./generate_protocol.ts";
import {
  AUTHENTICATED_PROMPT,
  LifecycleScenarioError,
  runLifecycleScenario,
} from "./lifecycle_scenario.ts";
import { JsonlClient, ProtocolResponseError } from "./jsonl_client.ts";
import { PreflightError, runStaticPreflight } from "./preflight.ts";
import { spawnShutdownProcessHost } from "./process_host.ts";
import {
  type DarwinProcessRecord,
  readDarwinProcessSnapshot,
} from "./process_tree_darwin.ts";
import { ProtocolValidator } from "./protocol_validation.ts";
import {
  type ShutdownBounds,
  ShutdownError,
  type ShutdownEvidence,
} from "./shutdown.ts";
import {
  buildVerifyOnlyCandidate,
  redactAndValidateTranscript,
  TranscriptRecorder,
  TranscriptValidationError,
  type VerifyOnlyCandidate,
} from "./transcript.ts";

const CODEX_EXECUTABLE = "/opt/homebrew/bin/codex";
const FORWARDED_ENVIRONMENT = [
  "CODEX_HOME",
  "HOME",
  "PATH",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "SHELL",
] as const;

export class SpikeRunError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly stage: string,
    public readonly nextAction: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SpikeRunError";
  }
}

function selectedCodexEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of FORWARDED_ENVIRONMENT) {
    const value = Deno.env.get(key);
    if (value !== undefined) environment[key] = value;
  }
  if (environment.HOME === undefined && environment.CODEX_HOME === undefined) {
    throw new SpikeRunError(
      "CODEX_HOME_UNAVAILABLE",
      "neither the caller-selected CODEX_HOME nor the caller default home is available",
      "preflight.environment",
      "run with the existing authenticated caller environment",
    );
  }
  return environment;
}

async function observedProcessesStillPresent(
  trackedPids: Set<number>,
  processGroupId: number,
): Promise<DarwinProcessRecord[]> {
  const snapshot = await readDarwinProcessSnapshot();
  for (const process of snapshot) {
    if (process.processGroupId === processGroupId) {
      trackedPids.add(process.pid);
    }
  }
  return snapshot.filter((process) => trackedPids.has(process.pid));
}

async function waitForObservedAbsence(
  trackedPids: Set<number>,
  processGroupId: number,
  timeoutMs: number,
): Promise<DarwinProcessRecord[]> {
  const deadline = performance.now() + timeoutMs;
  let remaining = await observedProcessesStillPresent(
    trackedPids,
    processGroupId,
  );
  while (remaining.length > 0 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    remaining = await observedProcessesStillPresent(
      trackedPids,
      processGroupId,
    );
  }
  return remaining;
}

async function signalObservedGroupMembers(
  processes: readonly DarwinProcessRecord[],
  processGroupId: number,
  signal: "SIGTERM" | "SIGKILL",
): Promise<boolean> {
  let signaled = false;
  for (const priorObservation of processes) {
    const process = (await readDarwinProcessSnapshot()).find((candidate) =>
      candidate.pid === priorObservation.pid
    );
    if (process === undefined) continue;
    if (process.processGroupId !== processGroupId) {
      throw new SpikeRunError(
        "UNSAFE_PROCESS_GROUP",
        "an observed PID no longer belongs to the owned process group",
        "shutdown.phase5-reap.verify",
        "retain the compatibility blocker and do not signal the unverifiable PID",
      );
    }
    if (process.state.startsWith("Z")) continue;
    const output = await new Deno.Command("/bin/kill", {
      args: [
        `-${signal.replace(/^SIG/, "")}`,
        "--",
        String(process.pid),
      ],
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new SpikeRunError(
        "CLOSE_FAILED",
        "a verified observed process could not be signaled",
        "shutdown.phase5-reap.signal",
        "retain the compatibility blocker and inspect the remaining owned process",
      );
    }
    signaled = true;
  }
  return signaled;
}

async function recoverPinnedObservedTree(
  error: ShutdownError,
  bounds: ShutdownBounds,
): Promise<ShutdownEvidence> {
  if (error.code !== "DESCENDANT_LEAK") throw error;
  const initial = error.evidence;
  const trackedPids = new Set(initial.observedPids);
  const processGroupId = initial.rootIdentity.processGroupId;
  let remaining = await waitForObservedAbsence(
    trackedPids,
    processGroupId,
    bounds.gracefulExitMs,
  );
  const signalPath = [...initial.signalPath];
  const timedOutStages = [...initial.timedOutStages];
  if (remaining.length > 0) {
    if (!timedOutStages.includes("graceful")) {
      timedOutStages.push("graceful");
    }
    if (
      await signalObservedGroupMembers(
        remaining,
        processGroupId,
        "SIGTERM",
      )
    ) {
      signalPath.push("SIGTERM");
    }
    remaining = await waitForObservedAbsence(
      trackedPids,
      processGroupId,
      bounds.terminateExitMs,
    );
  }
  if (remaining.length > 0) {
    if (!timedOutStages.includes("terminate")) {
      timedOutStages.push("terminate");
    }
    if (
      await signalObservedGroupMembers(
        remaining,
        processGroupId,
        "SIGKILL",
      )
    ) {
      signalPath.push("SIGKILL");
    }
    remaining = await waitForObservedAbsence(
      trackedPids,
      processGroupId,
      bounds.forceExitMs,
    );
  }
  const completedAtMs = performance.now();
  const evidence: ShutdownEvidence = {
    ...initial,
    observedPids: [...trackedPids].sort((left, right) => left - right),
    signalPath,
    timedOutStages,
    timings: {
      ...initial.timings,
      completedAtMs,
      totalMs: completedAtMs - initial.timings.startedAtMs,
    },
    remainingPids: remaining.map((process) => process.pid).sort((
      left,
      right,
    ) => left - right),
    noObservedDescendantsRemain: remaining.length === 0,
    diagnostics: initial.diagnostics.filter((diagnostic) =>
      diagnostic.code !== "DESCENDANT_LEAK"
    ),
  };
  if (remaining.length > 0) {
    throw new ShutdownError(error.diagnostic, evidence);
  }
  return evidence;
}

export async function runVerifyOnly(): Promise<VerifyOnlyCandidate> {
  await runStaticPreflight({
    mode: "spike:verify",
    codexExecutable: CODEX_EXECUTABLE,
  });
  const configuration = await verifyProtocol(CODEX_EXECUTABLE, 1);
  const [validator, evidenceSchema, surface] = await Promise.all([
    ProtocolValidator.load(`${configuration.generatedRoot}/json-schema`),
    Deno.readTextFile(
      `${configuration.repositoryRoot}/spikes/codex-app-server/schemas/evidence.schema.json`,
    ).then(JSON.parse),
    extractStableSurface(`${configuration.generatedRoot}/json-schema`),
  ]);
  const childEnvironment = selectedCodexEnvironment();
  const lifecycle = await runLifecycleScenario({
    compatibility: configuration.compatibility,
    prompt: AUTHENTICATED_PROMPT,
    createClient: async (repositoryPath) => {
      const recorder = new TranscriptRecorder();
      const limits = configuration.compatibility.limits;
      const host = await spawnShutdownProcessHost({
        executable: CODEX_EXECUTABLE,
        args: configuration.compatibility.codex.appServerArgs,
        cwd: repositoryPath,
        env: childEnvironment,
        maxStderrBytes: limits.maxStderrBytes,
        shutdownBounds: {
          gracefulExitMs: limits.gracefulExitMs,
          terminateExitMs: limits.terminateExitMs,
          forceExitMs: limits.forceExitMs,
        },
      });
      const client = JsonlClient.connect({
        host,
        validator,
        recorder,
        limits: {
          maxStdoutLineBytes: limits.maxStdoutLineBytes,
          maxQueueMessages: limits.maxQueueMessages,
          maxQueueBytes: limits.maxQueueBytes,
          requestTimeoutMs: limits.initializeMs,
        },
      });
      let closePromise: ReturnType<typeof client.close> | undefined;
      return {
        recorder,
        request: client.request.bind(client),
        notify: client.notify.bind(client),
        messages: client.messages.bind(client),
        close() {
          closePromise ??= (async () => {
            try {
              return await client.close();
            } catch (error) {
              if (!(error instanceof ShutdownError)) throw error;
              const shutdown = await recoverPinnedObservedTree(error, {
                gracefulExitMs: limits.gracefulExitMs,
                terminateExitMs: limits.terminateExitMs,
                forceExitMs: limits.forceExitMs,
              });
              const stderr = await client.host.stderrCapture;
              if (shutdown.directExit === undefined) {
                throw new SpikeRunError(
                  "SHUTDOWN_STATUS_MISSING",
                  "recovered observed-tree cleanup lacks direct child status",
                  "shutdown.phase5-reap",
                  "retain the compatibility blocker and inspect shutdown evidence",
                );
              }
              return {
                childExit: shutdown.directExit,
                stderr,
                shutdown,
              };
            }
          })();
          return closePromise;
        },
      };
    },
  });
  const shutdown = lifecycle.processClose.shutdown;
  if (shutdown === undefined) {
    throw new SpikeRunError(
      "SHUTDOWN_EVIDENCE_MISSING",
      "the live process closed without bounded shutdown evidence",
      "verify.shutdown",
      "retain the compatibility blocker and inspect the process-host integration",
    );
  }
  const sensitivePaths = [
    lifecycle.repositoryPath,
    configuration.repositoryRoot,
    ...["CODEX_HOME", "HOME"].flatMap((key) => {
      const value = childEnvironment[key];
      return value === undefined ? [] : [value];
    }),
  ];
  const rawTexts = [AUTHENTICATED_PROMPT, lifecycle.agentText];
  const retained = await redactAndValidateTranscript(
    lifecycle.transcript,
    validator,
    evidenceSchema,
    { sensitivePaths, rawTexts },
  );
  const coverage = deriveCoverageFromJournal(
    configuration.coverage,
    surface,
    retained,
  );
  validateCoverageMembership(coverage, surface);
  return buildVerifyOnlyCandidate({
    configuration,
    lifecycle,
    measurements: lifecycle.measurements,
    retained,
    coverage,
    shutdown,
    stderrBytes: lifecycle.processClose.stderr.totalBytes,
    stderrText: lifecycle.processClose.stderr.retainedText,
    evidenceSchema,
    account: lifecycle.account,
    sensitivePaths,
    rawTexts,
  });
}

function blockerFor(error: unknown): {
  code: string;
  stage: string;
  nextAction: string;
  facts?: Record<string, unknown>;
} {
  if (error instanceof PreflightError) {
    return {
      code: error.code,
      stage: error.diagnostic.stage,
      nextAction: error.diagnostic.nextAction,
    };
  }
  if (error instanceof ShutdownError) {
    return {
      code: error.code,
      stage: error.diagnostic.stage,
      nextAction: error.diagnostic.nextAction,
      facts: {
        directExit: error.evidence.directExit,
        drains: error.evidence.drains,
        signalPath: error.evidence.signalPath,
        remainingPids: error.evidence.remainingPids,
        noObservedDescendantsRemain: error.evidence.noObservedDescendantsRemain,
        escapedDescendantContainmentProven:
          error.evidence.escapedDescendantContainmentProven,
        totalShutdownMs: error.evidence.timings.totalMs,
        diagnosticCodes: error.evidence.diagnostics.map((diagnostic) =>
          diagnostic.code
        ),
      },
    };
  }
  if (error instanceof TransportError) {
    return {
      code: error.code,
      stage: error.diagnostic.stage,
      nextAction: error.diagnostic.nextAction,
    };
  }
  if (error instanceof SpikeRunError) {
    return {
      code: error.code,
      stage: error.stage,
      nextAction: error.nextAction,
    };
  }
  if (
    error instanceof ContractError ||
    error instanceof LifecycleScenarioError ||
    error instanceof TranscriptValidationError
  ) {
    return {
      code: error.code,
      stage: error instanceof ContractError
        ? "verify.contract"
        : error instanceof LifecycleScenarioError
        ? "verify.lifecycle"
        : "verify.transcript",
      nextAction:
        "retain the compatibility blocker and inspect the typed verification failure",
    };
  }
  if (error instanceof ProtocolResponseError) {
    return {
      code: "PROTOCOL_RESPONSE_ERROR",
      stage: "verify.protocol-response",
      nextAction:
        "retain the compatibility blocker and inspect the pinned app-server response",
    };
  }
  return {
    code: "SPIKE_VERIFY_FAILED",
    stage: "verify",
    nextAction:
      "retain the compatibility blocker and inspect the local typed diagnostics",
  };
}

function safeSuccess(candidate: VerifyOnlyCandidate): Record<string, unknown> {
  const summary = candidate.summaryInputs;
  return {
    status: "verified",
    evidence: "in-memory-only",
    versions: summary.versions,
    platform: summary.platform,
    observationsMs: summary.observationsMs,
    lifecycle: {
      stdoutLines: summary.lifecycle.stdoutLines,
      stderrBytes: summary.lifecycle.stderrBytes,
      terminalStatus: summary.lifecycle.terminalStatus,
      completedItems: summary.lifecycle.completedItems,
      completedAgentMessages: summary.lifecycle.completedAgentMessages,
    },
    shutdown: {
      directExit: summary.shutdown.directExit,
      drains: summary.shutdown.drains,
      signalPath: summary.shutdown.signalPath,
      remainingPids: summary.shutdown.remainingPids,
      noObservedDescendantsRemain: summary.shutdown.noObservedDescendantsRemain,
      escapedDescendantContainmentProven:
        summary.shutdown.escapedDescendantContainmentProven,
      totalMs: summary.shutdown.timings.totalMs,
    },
    retainedRecords: candidate.transcript.length,
    observedCoverageEntries:
      candidate.coverage.entries.filter((entry) => entry.observedCount > 0)
        .length,
    gates: summary.gates,
  };
}

if (import.meta.main) {
  try {
    const mode = Deno.args[0] ?? "verify";
    if (mode !== "verify") {
      throw new SpikeRunError(
        "ACCEPTANCE_NOT_IMPLEMENTED",
        "acceptance publication belongs to Phase 6",
        "acceptance",
        "run spike:verify until the separately reviewed publication phase is implemented",
      );
    }
    console.log(JSON.stringify(safeSuccess(await runVerifyOnly())));
  } catch (error) {
    console.error(JSON.stringify({
      status: "blocked",
      blocker: blockerFor(error),
    }));
    Deno.exit(1);
  }
}
