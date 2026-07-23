import {
  deriveCoverageFromJournal,
  extractStableSurface,
  serializeCoverage,
  validateCoverageMembership,
} from "./coverage.ts";
import {
  canonicalJsonBytes,
  ContractError,
  type CoverageManifest,
  hashCanonicalJson,
  loadConfiguration,
  parseJsonRejectDuplicateKeys,
  sha256Hex,
} from "./config.ts";
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
import {
  ProtocolValidator,
  validateJsonAgainstSchema,
} from "./protocol_validation.ts";
import {
  type ShutdownBounds,
  ShutdownError,
  type ShutdownEvidence,
} from "./shutdown.ts";
import {
  buildVerifyOnlyCandidate,
  parseAndValidateRetainedTranscript,
  redactAndValidateTranscript,
  type RetainedProtocolRecord,
  serializeRetainedTranscript,
  TranscriptRecorder,
  TranscriptValidationError,
  validateLifecycleRecords,
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
const REQUIRED_ACCEPTANCE_GATES = [
  "authenticatedTurnCompleted",
  "coverageComplete",
  "everyRetainedEnvelopeSchemaValid",
  "exactVersions",
  "generatedArtifactsMatch",
  "lifecycleOrdered",
  "noObservedDescendantsRemain",
] as const;

export type AcceptanceSummary = {
  schemaVersion: 1;
  runId: string;
  recordedAt: string;
  platform: { os: "darwin"; arch: "aarch64" };
  versions: { deno: "2.9.3"; codex: "0.145.0" };
  hashes: {
    compatibility: string;
    generatedBundle: string;
    coverage: string;
    transcript: string;
  };
  observationsMs: VerifyOnlyCandidate["summaryInputs"]["observationsMs"];
  lifecycle: Omit<
    VerifyOnlyCandidate["summaryInputs"]["lifecycle"],
    "completedAgentMessages"
  >;
  shutdown: ShutdownEvidence;
  gates: Record<(typeof REQUIRED_ACCEPTANCE_GATES)[number], true>;
};

export type AcceptanceProofPaths = {
  coverage: string;
  transcript: string;
  summary: string;
};

export type AcceptanceProofValidation = {
  status: "validated";
  summary: AcceptanceSummary;
  coverage: CoverageManifest;
  transcript: RetainedProtocolRecord[];
};

export type AcceptanceProofStatus =
  | AcceptanceProofValidation
  | { status: "candidate"; reason: string };

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

function fixedProofPaths(repositoryRoot: string): AcceptanceProofPaths {
  const root = `${repositoryRoot}/spikes/codex-app-server`;
  return {
    coverage: `${root}/coverage.json`,
    transcript: `${root}/evidence/authenticated-turn.redacted.jsonl`,
    summary: `${root}/evidence/authenticated-turn.summary.json`,
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

function requireAcceptanceGates(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError(
      "ACCEPTANCE_GATES_INVALID",
      "acceptance gates must be an object",
    );
  }
  const gates = value as Record<string, unknown>;
  const actual = Object.keys(gates).sort();
  if (
    JSON.stringify(actual) !==
      JSON.stringify([...REQUIRED_ACCEPTANCE_GATES].sort())
  ) {
    throw new ContractError(
      "ACCEPTANCE_GATES_INVALID",
      "acceptance summary has a missing or unsupported true gate",
      { expected: REQUIRED_ACCEPTANCE_GATES, actual },
    );
  }
  for (const gate of REQUIRED_ACCEPTANCE_GATES) {
    if (gates[gate] !== true) {
      throw new ContractError(
        "ACCEPTANCE_GATE_FALSE",
        `acceptance-required gate ${gate} is not true`,
      );
    }
  }
}

function requireShutdownAcceptance(shutdown: ShutdownEvidence): void {
  if (
    shutdown.directExit === undefined ||
    shutdown.drains.stdoutCompleted !== true ||
    shutdown.drains.stderrCompleted !== true ||
    shutdown.remainingPids.length !== 0 ||
    shutdown.noObservedDescendantsRemain !== true
  ) {
    throw new ContractError(
      "ACCEPTANCE_SHUTDOWN_INVALID",
      "accepted evidence requires direct status, settled drains, and no remaining observed process",
    );
  }
  if (typeof shutdown.escapedDescendantContainmentProven !== "boolean") {
    throw new ContractError(
      "CONTAINMENT_FACT_MISSING",
      "escaped-descendant containment must remain an explicit evidence fact",
    );
  }
  if (shutdown.escapedDescendantContainmentProven) {
    const capability = shutdown.containmentCapability;
    if (
      !capability.available || !capability.armedBeforeChildExecution ||
      !capability.continuouslyTracked || !capability.creationEventsCovered ||
      !capability.sessionEscapeCovered || !capability.reparentingCovered ||
      capability.lossDetected || capability.overflowed
    ) {
      throw new ContractError(
        "CONTAINMENT_PROOF_UNSUPPORTED",
        "escaped-descendant containment is true without race-closing proof evidence",
      );
    }
  }
}

export async function validateAcceptanceProofSet(options: {
  repositoryRoot: string;
  paths?: AcceptanceProofPaths;
}): Promise<AcceptanceProofValidation> {
  const paths = options.paths ?? fixedProofPaths(options.repositoryRoot);
  const [coverageBytes, transcriptBytes, summaryBytes] = await Promise.all([
    Deno.readFile(paths.coverage),
    Deno.readFile(paths.transcript),
    Deno.readFile(paths.summary),
  ]);
  const configuration = await loadConfiguration({
    repositoryRoot: options.repositoryRoot,
    coveragePath: paths.coverage,
  });
  const coverage = configuration.coverage;
  if (!bytesEqual(coverageBytes, serializeCoverage(coverage))) {
    throw new ContractError(
      "COVERAGE_NOT_CANONICAL",
      "accepted coverage must use canonical JSON with one final newline",
    );
  }
  const [validator, evidenceSchema, surface] = await Promise.all([
    ProtocolValidator.load(`${configuration.generatedRoot}/json-schema`),
    Deno.readTextFile(
      `${options.repositoryRoot}/spikes/codex-app-server/schemas/evidence.schema.json`,
    ).then((source) => parseJsonRejectDuplicateKeys(source)),
    extractStableSurface(`${configuration.generatedRoot}/json-schema`),
  ]);
  const transcript = parseAndValidateRetainedTranscript(
    transcriptBytes,
    validator,
    evidenceSchema,
  );
  const summaryValue = parseJsonRejectDuplicateKeys(summaryBytes);
  if (!bytesEqual(summaryBytes, canonicalJsonBytes(summaryValue))) {
    throw new ContractError(
      "SUMMARY_NOT_CANONICAL",
      "acceptance summary must use canonical JSON with one final newline",
    );
  }
  validateJsonAgainstSchema(
    evidenceSchema,
    summaryValue,
    "ACCEPTANCE_SUMMARY_SCHEMA_INVALID",
  );
  const summary = summaryValue as AcceptanceSummary;
  requireAcceptanceGates(summary.gates);
  requireShutdownAcceptance(summary.shutdown);

  if (
    summary.versions.deno !== configuration.compatibility.deno.version ||
    summary.versions.codex !== configuration.compatibility.codex.cliVersion ||
    summary.platform.os !== configuration.compatibility.validationPlatform.os ||
    summary.platform.arch !==
      configuration.compatibility.validationPlatform.arch
  ) {
    throw new ContractError(
      "ACCEPTANCE_VERSION_PLATFORM_MISMATCH",
      "acceptance versions or platform disagree with immutable compatibility inputs",
    );
  }
  const compatibilityValue = parseJsonRejectDuplicateKeys(
    await Deno.readFile(configuration.compatibilityPath),
  );
  const expectedHashes = {
    compatibility: await hashCanonicalJson(compatibilityValue),
    generatedBundle: configuration.compatibility.generation.bundleSha256,
    coverage: await sha256Hex(coverageBytes),
    transcript: await sha256Hex(transcriptBytes),
  };
  if (
    summary.hashes.compatibility !== expectedHashes.compatibility ||
    summary.hashes.generatedBundle !== expectedHashes.generatedBundle ||
    summary.hashes.coverage !== expectedHashes.coverage ||
    summary.hashes.transcript !== expectedHashes.transcript
  ) {
    throw new ContractError(
      "ACCEPTANCE_HASH_MISMATCH",
      "acceptance cross-hashes disagree with current immutable or proof artifacts",
      { expected: expectedHashes, observed: summary.hashes },
    );
  }

  validateCoverageMembership(coverage, surface);
  deriveCoverageFromJournal(coverage, surface, transcript, coverage);
  const lifecycle = validateLifecycleRecords(transcript, {
    threadId: summary.lifecycle.threadId,
    turnId: summary.lifecycle.turnId,
  });
  if (
    lifecycle.terminalStatus !== "completed" ||
    lifecycle.completedItems !== summary.lifecycle.completedItems ||
    summary.lifecycle.terminalStatus !== "completed" ||
    summary.lifecycle.stdoutLines !==
      transcript.filter((record) => record.direction === "server").length
  ) {
    throw new ContractError(
      "ACCEPTANCE_LIFECYCLE_MISMATCH",
      "acceptance lifecycle summary disagrees with the retained journal",
    );
  }
  return { status: "validated", summary, coverage, transcript };
}

export async function deriveAcceptanceProofStatus(options: {
  repositoryRoot: string;
  paths?: AcceptanceProofPaths;
}): Promise<AcceptanceProofStatus> {
  try {
    return await validateAcceptanceProofSet(options);
  } catch (error) {
    return {
      status: "candidate",
      reason: error instanceof ContractError ||
          error instanceof TranscriptValidationError
        ? error.code
        : error instanceof Deno.errors.NotFound
        ? "PROOF_SET_MEMBER_MISSING"
        : "PROOF_SET_INVALID",
    };
  }
}

export async function publishAcceptanceProofSet(options: {
  repositoryRoot: string;
  coverageBytes: Uint8Array;
  transcriptBytes: Uint8Array;
  summaryBytes: Uint8Array;
  beforeReplace?: (path: string, index: number) => void | Promise<void>;
  afterReplace?: (path: string, index: number) => void | Promise<void>;
}): Promise<AcceptanceProofValidation> {
  const outputs = fixedProofPaths(options.repositoryRoot);
  const evidenceDirectory =
    `${options.repositoryRoot}/spikes/codex-app-server/evidence`;
  await Deno.mkdir(evidenceDirectory, { recursive: true });
  const stagingDirectory = await Deno.makeTempDir({
    dir: evidenceDirectory,
    prefix: ".acceptance-stage-",
  });
  const staged: AcceptanceProofPaths = {
    coverage: `${stagingDirectory}/coverage.json`,
    transcript: `${stagingDirectory}/authenticated-turn.redacted.jsonl`,
    summary: `${stagingDirectory}/authenticated-turn.summary.json`,
  };
  try {
    await Promise.all([
      Deno.writeFile(staged.coverage, options.coverageBytes),
      Deno.writeFile(staged.transcript, options.transcriptBytes),
      Deno.writeFile(staged.summary, options.summaryBytes),
    ]);
    await validateAcceptanceProofSet({
      repositoryRoot: options.repositoryRoot,
      paths: staged,
    });
    const replacements = [
      [staged.coverage, outputs.coverage],
      [staged.transcript, outputs.transcript],
      [staged.summary, outputs.summary],
    ] as const;
    for (let index = 0; index < replacements.length; index++) {
      const [source, destination] = replacements[index];
      await options.beforeReplace?.(destination, index);
      await Deno.rename(source, destination);
      await options.afterReplace?.(destination, index);
    }
  } finally {
    await Deno.remove(stagingDirectory, { recursive: true }).catch(() => {});
  }
  return await validateAcceptanceProofSet({
    repositoryRoot: options.repositoryRoot,
  });
}

export async function runVerifyOnly(
  mode: "spike:verify" | "spike:accept" = "spike:verify",
): Promise<VerifyOnlyCandidate> {
  await runStaticPreflight({
    mode,
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

export async function runAcceptance(): Promise<AcceptanceProofValidation> {
  const candidate = await runVerifyOnly("spike:accept");
  const configuration = await verifyProtocol(CODEX_EXECUTABLE, 1);
  if (
    candidate.coverage.generatedBundleSha256 !==
      configuration.compatibility.generation.bundleSha256
  ) {
    throw new ContractError(
      "ACCEPTANCE_INPUT_STALE",
      "live candidate coverage disagrees with the immediately reverified generated bundle",
    );
  }
  const coverageBytes = serializeCoverage(candidate.coverage);
  const transcriptBytes = serializeRetainedTranscript(candidate.transcript);
  const compatibilityValue = parseJsonRejectDuplicateKeys(
    await Deno.readFile(configuration.compatibilityPath),
  );
  const summary: AcceptanceSummary = {
    schemaVersion: 1,
    runId: crypto.randomUUID(),
    recordedAt: new Date().toISOString(),
    platform: candidate.summaryInputs.platform,
    versions: candidate.summaryInputs.versions,
    hashes: {
      compatibility: await hashCanonicalJson(compatibilityValue),
      generatedBundle: configuration.compatibility.generation.bundleSha256,
      coverage: await sha256Hex(coverageBytes),
      transcript: await sha256Hex(transcriptBytes),
    },
    observationsMs: candidate.summaryInputs.observationsMs,
    lifecycle: {
      stdoutLines: candidate.summaryInputs.lifecycle.stdoutLines,
      stderrBytes: candidate.summaryInputs.lifecycle.stderrBytes,
      threadId: candidate.summaryInputs.lifecycle.threadId,
      turnId: candidate.summaryInputs.lifecycle.turnId,
      terminalStatus: candidate.summaryInputs.lifecycle.terminalStatus,
      completedItems: candidate.summaryInputs.lifecycle.completedItems,
    },
    shutdown: candidate.summaryInputs.shutdown,
    gates: candidate.summaryInputs.gates,
  };
  return await publishAcceptanceProofSet({
    repositoryRoot: configuration.repositoryRoot,
    coverageBytes,
    transcriptBytes,
    summaryBytes: canonicalJsonBytes(summary),
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
    if (mode !== "verify" && mode !== "accept") {
      throw new SpikeRunError(
        "SPIKE_MODE_INVALID",
        `unsupported spike mode ${mode}`,
        "startup",
        "run the repository-owned spike:verify or spike:accept task",
      );
    }
    if (mode === "accept") {
      const accepted = await runAcceptance();
      console.log(JSON.stringify({
        status: accepted.status,
        evidence: "published-proof-set",
        hashes: accepted.summary.hashes,
        retainedRecords: accepted.transcript.length,
        observedCoverageEntries: accepted.coverage.entries.filter((entry) =>
          entry.observedCount > 0
        ).length,
        gates: accepted.summary.gates,
      }));
    } else {
      console.log(JSON.stringify(safeSuccess(await runVerifyOnly())));
    }
  } catch (error) {
    console.error(JSON.stringify({
      status: "blocked",
      blocker: blockerFor(error),
    }));
    Deno.exit(1);
  }
}
