import {
  deriveCoverageFromJournal,
  extractStableSurface,
  serializeCoverage,
} from "../src/coverage.ts";
import {
  canonicalJsonBytes,
  compareGeneratedTrees,
  ContractError,
  discoverRepositoryRoot,
  hashCanonicalJson,
  hashGeneratedTree,
  loadConfiguration,
  ORDERING_EXCEPTION,
  parseJsonRejectDuplicateKeys,
  resolveRepositoryPath,
  sha256Hex,
} from "../src/config.ts";
import { verifyProtocol } from "../src/generate_protocol.ts";
import {
  type AcceptanceSummary,
  deriveAcceptanceProofStatus,
  publishAcceptanceProofSet,
} from "../src/main.ts";
import { validateJsonAgainstSchema } from "../src/protocol_validation.ts";
import type { ShutdownEvidence } from "../src/shutdown.ts";
import {
  type RetainedProtocolRecord,
  serializeRetainedTranscript,
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
  operation: () => unknown | Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert(
      error instanceof Error && error.message.startsWith(`${code}:`),
      `expected ${code}, received ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  throw new Error(`expected ${code}`);
}

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = `${source}/${entry.name}`;
    const to = `${destination}/${entry.name}`;
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}

async function makeConfigurationFixture(
  repositoryRoot: string,
): Promise<string> {
  const root = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "vantage-config-fixture-",
  });
  await Deno.writeTextFile(`${root}/deno.json`, "{}\n");
  await Deno.mkdir(`${root}/spikes/codex-app-server`, { recursive: true });
  for (const name of ["compatibility.json", "coverage.json"]) {
    await Deno.copyFile(
      `${repositoryRoot}/spikes/codex-app-server/${name}`,
      `${root}/spikes/codex-app-server/${name}`,
    );
  }
  await copyTree(
    `${repositoryRoot}/spikes/codex-app-server/schemas`,
    `${root}/spikes/codex-app-server/schemas`,
  );
  await copyTree(
    `${repositoryRoot}/spikes/codex-app-server/generated`,
    `${root}/spikes/codex-app-server/generated`,
  );
  return root;
}

type ProofFixture = {
  root: string;
  coverageBytes: Uint8Array;
  transcriptBytes: Uint8Array;
  summaryBytes: Uint8Array;
};

async function makeValidProofFixture(
  repositoryRoot: string,
): Promise<ProofFixture> {
  const root = await makeConfigurationFixture(repositoryRoot);
  const configuration = await loadConfiguration({ repositoryRoot: root });
  const threadId = "thread-proof";
  const turnId = "turn-proof";
  const itemId = "item-proof";
  const redactedText = `[redacted-text:sha256:${"0".repeat(64)}]`;
  const redactedPath = `/redacted/path/${"0".repeat(24)}`;
  const thread = {
    id: threadId,
    sessionId: "session-proof",
    preview: "",
    ephemeral: true,
    modelProvider: "fake",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    cwd: redactedPath,
    cliVersion: "0.145.0",
    source: "appServer",
    turns: [],
  };
  const activeTurn = { id: turnId, items: [], status: "inProgress" };
  const completedItem = {
    type: "agentMessage",
    id: itemId,
    text: redactedText,
  };
  let observationIndex = 0;
  let wireIndex = 0;
  const client = (
    method: string,
    params: unknown,
    id?: number,
    nativeIds: Record<string, string> = {},
  ): RetainedProtocolRecord => {
    const record: Record<string, unknown> = {
      direction: "client",
      observationIndex: observationIndex++,
      monotonicOffsetMs: observationIndex,
      method,
      params,
      byteLength: 1,
      schema: {
        id: `${
          id === undefined ? "client-notification" : "client-request"
        }:${method}`,
        valid: true,
      },
      nativeIds,
    };
    if (id !== undefined) record.id = id;
    return record as RetainedProtocolRecord;
  };
  const response = (
    id: number,
    method: string,
    result: unknown,
    nativeIds: Record<string, string> = {},
  ): RetainedProtocolRecord =>
    ({
      direction: "server",
      observationIndex: observationIndex++,
      wireIndex: wireIndex++,
      monotonicOffsetMs: observationIndex,
      byteLength: 1,
      envelope: { kind: "response", id, result },
      schema: { id: `client-response:${method}`, valid: true },
      nativeIds,
    }) as RetainedProtocolRecord;
  const notification = (
    method: string,
    params: unknown,
    nativeIds: Record<string, string> = {},
  ): RetainedProtocolRecord =>
    ({
      direction: "server",
      observationIndex: observationIndex++,
      wireIndex: wireIndex++,
      monotonicOffsetMs: observationIndex,
      byteLength: 1,
      envelope: { kind: "server-notification", method, params },
      schema: { id: `server-notification:${method}`, valid: true },
      nativeIds,
    }) as RetainedProtocolRecord;
  const transcript: RetainedProtocolRecord[] = [
    client("initialize", {
      clientInfo: {
        name: "vantage-protocol-spike",
        title: "Vantage protocol compatibility spike",
        version: "1",
      },
      capabilities: null,
    }, 1),
    response(1, "initialize", {
      codexHome: redactedPath,
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: "proof",
    }),
    client("initialized", undefined),
    client("thread/start", {
      model: "offline-model",
      cwd: redactedPath,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    }, 2),
    response(2, "thread/start", {
      thread,
      model: "offline-model",
      modelProvider: "fake",
      cwd: redactedPath,
      instructionSources: [],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "readOnly" },
    }, { threadId }),
    notification("thread/started", { thread }, { threadId }),
    client(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: redactedText, text_elements: [] }],
      },
      3,
      { threadId },
    ),
    response(3, "turn/start", { turn: activeTurn }, { turnId }),
    notification(
      "turn/started",
      { threadId, turn: activeTurn },
      { threadId, turnId },
    ),
    notification("item/started", {
      item: { type: "agentMessage", id: itemId, text: "" },
      threadId,
      turnId,
      startedAtMs: 1,
    }, { threadId, turnId, itemId }),
    notification("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId,
      delta: redactedText,
    }, { threadId, turnId, itemId }),
    notification("item/completed", {
      item: completedItem,
      threadId,
      turnId,
      completedAtMs: 2,
    }, { threadId, turnId, itemId }),
    notification("turn/completed", {
      threadId,
      turn: { id: turnId, items: [completedItem], status: "completed" },
    }, { threadId, turnId }),
  ];
  const [evidenceSchema, surface] = await Promise.all([
    Deno.readTextFile(
      `${root}/spikes/codex-app-server/schemas/evidence.schema.json`,
    ).then(JSON.parse),
    extractStableSurface(`${configuration.generatedRoot}/json-schema`),
  ]);
  for (const record of transcript) {
    validateJsonAgainstSchema(
      evidenceSchema,
      record,
      "EVIDENCE_SCHEMA_INVALID",
    );
  }
  const coverage = deriveCoverageFromJournal(
    configuration.coverage,
    surface,
    transcript,
  );
  const coverageBytes = serializeCoverage(coverage);
  const transcriptBytes = serializeRetainedTranscript(transcript);
  const shutdown = {
    rootIdentity: {
      rootPid: 100,
      processGroupId: 100,
      sessionId: 100,
    },
    observedPids: [100],
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
      unavailableReason: "test fixture has no race-closing tracker",
    },
    escapedDescendantContainmentProven: false,
    diagnostics: [],
  } as ShutdownEvidence;
  const compatibility = parseJsonRejectDuplicateKeys(
    await Deno.readFile(configuration.compatibilityPath),
  );
  const summary: AcceptanceSummary = {
    schemaVersion: 1,
    runId: "proof-fixture",
    recordedAt: "2026-07-23T00:00:00.000Z",
    platform: { os: "darwin", arch: "aarch64" },
    versions: { deno: "2.9.3", codex: "0.145.0" },
    hashes: {
      compatibility: await hashCanonicalJson(compatibility),
      generatedBundle: configuration.compatibility.generation.bundleSha256,
      coverage: await sha256Hex(coverageBytes),
      transcript: await sha256Hex(transcriptBytes),
    },
    observationsMs: {
      spawnToInitializeResponse: 1,
      initializeToReady: 1,
      turnStartToFirstEvent: 1,
      turnStartToCompleted: 2,
      stdinCloseToExit: 1,
      totalShutdown: 3,
    },
    lifecycle: {
      stdoutLines:
        transcript.filter((record) => record.direction === "server").length,
      stderrBytes: 0,
      threadId,
      turnId,
      terminalStatus: "completed",
      completedItems: 1,
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
  };
  const summaryBytes = canonicalJsonBytes(summary);
  await publishAcceptanceProofSet({
    repositoryRoot: root,
    coverageBytes,
    transcriptBytes,
    summaryBytes,
  });
  return { root, coverageBytes, transcriptBytes, summaryBytes };
}

async function writeTinyTree(
  root: string,
  aggregate: string,
  typeBytes = "export type Stable = true;\n",
): Promise<void> {
  await Deno.mkdir(`${root}/types`, { recursive: true });
  await Deno.mkdir(`${root}/json-schema`, { recursive: true });
  await Deno.writeTextFile(`${root}/types/stable.ts`, typeBytes);
  await Deno.writeTextFile(`${root}/${ORDERING_EXCEPTION}`, aggregate);
}

Deno.test("loads and separately exposes immutable and regeneration-derived state", async () => {
  const configuration = await loadConfiguration();
  assertEquals(configuration.compatibility.deno.version, "2.9.3");
  assertEquals(configuration.compatibility.codex.cliVersion, "0.145.0");
  assert(configuration.immutableInputsVerified);
  assertEquals(configuration.generatedArtifactsMatch, false);
  assertEquals(
    await hashGeneratedTree(configuration.generatedRoot, "raw"),
    configuration.compatibility.generation.bundleSha256,
  );
  assertEquals(
    await hashGeneratedTree(configuration.generatedRoot, "regeneration"),
    configuration.generation.regenerationSha256,
  );
  const forgedOptions = {
    regenerationVerified: true,
  } as unknown as Parameters<typeof loadConfiguration>[0];
  const forged = await loadConfiguration(forgedOptions);
  assertEquals(forged.generatedArtifactsMatch, false);
});

Deno.test("compatibility schema rejects literals, unknowns, paths, modes, and limits", async () => {
  const root = await discoverRepositoryRoot();
  const schema = JSON.parse(
    await Deno.readTextFile(
      `${root}/spikes/codex-app-server/schemas/compatibility.schema.json`,
    ),
  );
  const manifest = JSON.parse(
    await Deno.readTextFile(
      `${root}/spikes/codex-app-server/compatibility.json`,
    ),
  );
  type MutableManifest = {
    deno: { version: string };
    codex: { cliVersion: string };
    generation: {
      mode: string;
      typesCommand: string[];
      generatedRoot: string;
    };
    limits: { maxQueueMessages: number };
    status?: string;
  };
  const mutations: ((value: MutableManifest) => void)[] = [
    (value) => value.deno.version = "2.9.4",
    (value) => value.codex.cliVersion = "0.146.0",
    (value) => value.generation.mode = "experimental",
    (value) => value.generation.typesCommand.push("--experimental"),
    (value) => value.generation.generatedRoot = "/tmp/generated",
    (value) => value.generation.generatedRoot = "../generated",
    (value) => value.limits.maxQueueMessages = 0,
    (value) => value.status = "validated",
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(manifest) as MutableManifest;
    mutate(candidate);
    await assertRejectsCode(
      () =>
        validateJsonAgainstSchema(
          schema,
          candidate,
          "COMPATIBILITY_SCHEMA_INVALID",
        ),
      "COMPATIBILITY_SCHEMA_INVALID",
    );
  }
});

Deno.test("repository paths normalize separators and reject traversal and symlink escape", async () => {
  const root = await discoverRepositoryRoot();
  assertEquals(
    await resolveRepositoryPath(
      root,
      "spikes\\codex-app-server\\compatibility.json",
    ),
    `${root}/spikes/codex-app-server/compatibility.json`,
  );
  await assertRejectsCode(
    () => resolveRepositoryPath(root, "../outside"),
    "PATH_ESCAPE",
  );
  const fixture = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "vantage-path-fixture-",
  });
  const outside = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "vantage-path-outside-",
  });
  try {
    const link = await new Deno.Command("/bin/ln", {
      args: ["-s", outside, `${fixture}/escape`],
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(
      link.success,
      `ln failed: ${new TextDecoder().decode(link.stderr)}`,
    );
    await assertRejectsCode(
      () => resolveRepositoryPath(fixture, "escape"),
      "SYMLINK_ESCAPE",
    );
  } finally {
    await Deno.remove(fixture, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("configuration rejects generation metadata and committed-byte disagreement", async () => {
  const repositoryRoot = await discoverRepositoryRoot();
  const fixture = await makeConfigurationFixture(repositoryRoot);
  const metadataPath =
    `${fixture}/spikes/codex-app-server/generated/0.145.0/generation.json`;
  const compatibilityPath =
    `${fixture}/spikes/codex-app-server/compatibility.json`;
  const coveragePath = `${fixture}/spikes/codex-app-server/coverage.json`;
  const typePath =
    `${fixture}/spikes/codex-app-server/generated/0.145.0/types/AbsolutePathBuf.ts`;
  try {
    const originalMetadata = await Deno.readTextFile(metadataPath);
    const metadata = JSON.parse(originalMetadata);
    metadata.orderingException = "json-schema/another.json";
    await Deno.writeTextFile(metadataPath, `${JSON.stringify(metadata)}\n`);
    await assertRejectsCode(
      () => loadConfiguration({ repositoryRoot: fixture }),
      "GENERATION_METADATA_INVALID",
    );

    await Deno.writeTextFile(metadataPath, originalMetadata);
    const wrongRegenerationHash = JSON.parse(originalMetadata);
    wrongRegenerationHash.regenerationSha256 = "0".repeat(64);
    await Deno.writeTextFile(
      metadataPath,
      `${JSON.stringify(wrongRegenerationHash)}\n`,
    );
    await assertRejectsCode(
      () => loadConfiguration({ repositoryRoot: fixture }),
      "COMMITTED_REGENERATION_HASH_MISMATCH",
    );

    await Deno.writeTextFile(metadataPath, originalMetadata);
    const originalCompatibility = await Deno.readTextFile(compatibilityPath);
    const wrongBundleHash = JSON.parse(originalCompatibility);
    wrongBundleHash.generation.bundleSha256 = "0".repeat(64);
    await Deno.writeTextFile(
      compatibilityPath,
      `${JSON.stringify(wrongBundleHash)}\n`,
    );
    await assertRejectsCode(
      () => loadConfiguration({ repositoryRoot: fixture }),
      "COMMITTED_BUNDLE_HASH_MISMATCH",
    );

    await Deno.writeTextFile(compatibilityPath, originalCompatibility);
    const originalCoverage = await Deno.readTextFile(coveragePath);
    const incompleteCoverage = JSON.parse(originalCoverage);
    incompleteCoverage.entries.pop();
    await Deno.writeTextFile(
      coveragePath,
      `${JSON.stringify(incompleteCoverage)}\n`,
    );
    await assertRejectsCode(
      () => loadConfiguration({ repositoryRoot: fixture }),
      "COVERAGE_MEMBERSHIP_MISMATCH",
    );

    await Deno.writeTextFile(coveragePath, originalCoverage);
    const originalType = await Deno.readTextFile(typePath);
    await Deno.writeTextFile(typePath, `${originalType}// mutation\n`);
    await assertRejectsCode(
      () => loadConfiguration({ repositoryRoot: fixture }),
      "COMMITTED_BUNDLE_HASH_MISMATCH",
    );
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});

Deno.test("raw and regeneration hashes have exactly one ordering exception", async () => {
  const fixture = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "vantage-hash-fixture-",
  });
  const left = `${fixture}/left`;
  const right = `${fixture}/right`;
  try {
    await writeTinyTree(left, '{"z":1,"a":{"y":2,"x":[1,2]}}\n');
    await writeTinyTree(right, '{"a":{"x":[1,2],"y":2},"z":1}\n');
    assert(
      await hashGeneratedTree(left, "raw") !==
        await hashGeneratedTree(right, "raw"),
    );
    assertEquals(
      await hashGeneratedTree(left, "regeneration"),
      await hashGeneratedTree(right, "regeneration"),
    );
    assertEquals((await compareGeneratedTrees(left, right)).rawDiffs, [
      ORDERING_EXCEPTION,
    ]);

    await Deno.writeTextFile(
      `${right}/${ORDERING_EXCEPTION}`,
      '{"a":1,"a":1,"z":1}\n',
    );
    await assertRejectsCode(
      () => compareGeneratedTrees(left, right),
      "DUPLICATE_JSON_KEY",
    );

    for (
      const aggregate of [
        '{"a":{"x":[2,1],"y":2},"z":1}\n',
        '{"a":{"x":[1,2],"y":3},"z":1}\n',
        '{"a":{"x":[1,2],"y":2,"new":true},"z":1}\n',
      ]
    ) {
      await Deno.writeTextFile(`${right}/${ORDERING_EXCEPTION}`, aggregate);
      await assertRejectsCode(
        () => compareGeneratedTrees(left, right),
        "ORDERING_EXCEPTION_STRUCTURAL_MISMATCH",
      );
    }

    await Deno.writeTextFile(
      `${right}/${ORDERING_EXCEPTION}`,
      '{"a":{"x":[1,2],"y":2},"z":1}\n',
    );
    await Deno.writeTextFile(`${right}/types/stable.ts`, "changed\n");
    await assertRejectsCode(
      () => compareGeneratedTrees(left, right),
      "GENERATED_RAW_MISMATCH",
    );
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});

Deno.test("strict JSON and canonical proof hashing are deterministic", async () => {
  assertEquals(parseJsonRejectDuplicateKeys('{"b":2,"a":1}'), { b: 2, a: 1 });
  await assertRejectsCode(
    () => parseJsonRejectDuplicateKeys('{"x":1,"\\u0078":2}'),
    "DUPLICATE_JSON_KEY",
  );
  assertEquals(
    canonicalJsonBytes({ b: 2, a: { d: 4, c: 3 } }),
    canonicalJsonBytes({ a: { c: 3, d: 4 }, b: 2 }),
  );
  assertEquals(
    await hashCanonicalJson({ b: 2, a: 1 }),
    await hashCanonicalJson({ a: 1, b: 2 }),
  );
});

Deno.test("acceptance proof sets validate atomically and reject stale or partial state", async () => {
  const repositoryRoot = await discoverRepositoryRoot();
  const fixture = await makeValidProofFixture(repositoryRoot);
  const paths = {
    coverage: `${fixture.root}/spikes/codex-app-server/coverage.json`,
    transcript:
      `${fixture.root}/spikes/codex-app-server/evidence/authenticated-turn.redacted.jsonl`,
    summary:
      `${fixture.root}/spikes/codex-app-server/evidence/authenticated-turn.summary.json`,
  };
  const restore = async () => {
    await Promise.all([
      Deno.writeFile(paths.coverage, fixture.coverageBytes),
      Deno.writeFile(paths.transcript, fixture.transcriptBytes),
      Deno.writeFile(paths.summary, fixture.summaryBytes),
    ]);
  };
  const expectCandidate = async (label: string) => {
    assertEquals(
      (await deriveAcceptanceProofStatus({
        repositoryRoot: fixture.root,
      })).status,
      "candidate",
      label,
    );
    await restore();
  };
  try {
    const valid = await deriveAcceptanceProofStatus({
      repositoryRoot: fixture.root,
    });
    assertEquals(valid.status, "validated");
    assert(
      valid.status === "validated" &&
        valid.summary.shutdown.escapedDescendantContainmentProven === false,
      "accurate false escaped-containment evidence must remain eligible",
    );

    await Deno.remove(paths.transcript);
    await expectCandidate("missing proof member");

    await Deno.writeFile(
      paths.coverage,
      canonicalJsonBytes({
        ...parseJsonRejectDuplicateKeys(fixture.coverageBytes) as object,
        generatedBundleSha256: "0".repeat(64),
      }),
    );
    await expectCandidate("stale coverage");

    await Deno.writeFile(
      paths.transcript,
      new Uint8Array([...fixture.transcriptBytes, 0x0a]),
    );
    await expectCandidate("non-canonical transcript");

    const mutateSummary = async (
      mutate: (summary: Record<string, unknown>) => void,
      label: string,
    ) => {
      const summary = structuredClone(
        parseJsonRejectDuplicateKeys(fixture.summaryBytes),
      ) as Record<string, unknown>;
      mutate(summary);
      await Deno.writeFile(paths.summary, canonicalJsonBytes(summary));
      await expectCandidate(label);
    };
    await mutateSummary((summary) => {
      (summary.hashes as Record<string, unknown>).transcript = "0".repeat(64);
    }, "cross-hash mismatch");
    await mutateSummary((summary) => {
      (summary.gates as Record<string, unknown>).lifecycleOrdered = false;
    }, "false required gate");
    await mutateSummary((summary) => {
      delete (summary.gates as Record<string, unknown>).coverageComplete;
    }, "missing required gate");
    await mutateSummary((summary) => {
      (summary.gates as Record<string, unknown>)
        .escapedDescendantContainmentProven = true;
    }, "unsupported extra true gate");
    await mutateSummary((summary) => {
      delete (summary.shutdown as Record<string, unknown>)
        .escapedDescendantContainmentProven;
    }, "missing shutdown fact");
    await mutateSummary((summary) => {
      (summary.shutdown as Record<string, unknown>).remainingPids = [101];
    }, "remaining observed PID");
    await mutateSummary((summary) => {
      (summary.shutdown as Record<string, unknown>)
        .escapedDescendantContainmentProven = true;
    }, "unsupported true containment claim");

    const compatibilityPath =
      `${fixture.root}/spikes/codex-app-server/compatibility.json`;
    const compatibility = await Deno.readTextFile(compatibilityPath);
    const changedCompatibility = JSON.parse(compatibility);
    changedCompatibility.limits.maxQueueMessages++;
    await Deno.writeFile(
      compatibilityPath,
      canonicalJsonBytes(changedCompatibility),
    );
    await expectCandidate("changed immutable manifest");
    await Deno.writeTextFile(compatibilityPath, compatibility);

    const transcriptValues = new TextDecoder().decode(fixture.transcriptBytes)
      .trimEnd().split("\n").map((line) =>
        parseJsonRejectDuplicateKeys(line) as Record<string, unknown>
      );
    for (const value of transcriptValues) {
      value.monotonicOffsetMs = Number(value.monotonicOffsetMs) + 0.25;
    }
    const nextTranscriptBytes = new TextEncoder().encode(
      transcriptValues.map((value) =>
        new TextDecoder().decode(canonicalJsonBytes(value))
      ).join(""),
    );
    const nextSummary = structuredClone(
      parseJsonRejectDuplicateKeys(fixture.summaryBytes),
    ) as Record<string, unknown>;
    nextSummary.runId = "interrupted-replacement";
    (nextSummary.hashes as Record<string, unknown>).transcript =
      await sha256Hex(nextTranscriptBytes);
    const nextSummaryBytes = canonicalJsonBytes(nextSummary);
    for (const interruptedIndex of [0, 1, 2]) {
      await restore();
      await assertRejectsCode(
        () =>
          publishAcceptanceProofSet({
            repositoryRoot: fixture.root,
            coverageBytes: fixture.coverageBytes,
            transcriptBytes: nextTranscriptBytes,
            summaryBytes: nextSummaryBytes,
            beforeReplace: async (path, index) => {
              if (index !== interruptedIndex) return;
              if (index < 2) await Deno.remove(path);
              throw new ContractError(
                "PUBLICATION_INTERRUPTED",
                "injected replacement interruption",
              );
            },
          }),
        "PUBLICATION_INTERRUPTED",
      );
      assertEquals(
        (await deriveAcceptanceProofStatus({
          repositoryRoot: fixture.root,
        })).status,
        "candidate",
        `interruption before output ${interruptedIndex}`,
      );
    }
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test({
  name:
    "two independent stable regenerations match the committed structural contract",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const verified = await verifyProtocol("/opt/homebrew/bin/codex", 2);
    assertEquals(verified.generatedArtifactsMatch, true);
  },
});

Deno.test("ContractError exposes a stable code", () => {
  const error = new ContractError("EXAMPLE", "message");
  assertEquals(error.code, "EXAMPLE");
  assertEquals(error.message, "EXAMPLE: message");
});
