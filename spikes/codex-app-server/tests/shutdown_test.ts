import { loadConfiguration } from "../src/config.ts";
import { TransportError } from "../src/diagnostics.ts";
import {
  type ProcessHost,
  spawnShutdownProcessHost,
} from "../src/process_host.ts";
import { JsonlClient } from "../src/jsonl_client.ts";
import {
  captureOwnedProcessIdentity,
  containmentBlockerCode,
  type DarwinProcessRecord,
  DarwinSnapshotProcessTree,
  readDarwinProcessSnapshot,
  signalVerifiedProcessGroup,
  SNAPSHOT_ONLY_CAPABILITY,
} from "../src/process_tree_darwin.ts";
import {
  ShutdownError,
  type ShutdownPreparationHooks,
} from "../src/shutdown.ts";
import { ProtocolValidator } from "../src/protocol_validation.ts";
import { TranscriptRecorder } from "../src/transcript.ts";

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

async function assertShutdownError(
  operation: Promise<unknown>,
  code: string,
): Promise<ShutdownError> {
  try {
    await operation;
  } catch (error) {
    assert(error instanceof ShutdownError, `expected ShutdownError: ${error}`);
    assertEquals(error.code, code);
    return error;
  }
  throw new Error(`expected ${code}`);
}

const configurationPromise = loadConfiguration();
const validatorPromise = configurationPromise.then((configuration) =>
  ProtocolValidator.load(`${configuration.generatedRoot}/json-schema`)
);

type FixtureMarker = {
  fixture: "shutdown-descendant";
  pid: number;
  kind: "ordinary" | "surviving" | "escaped";
};

async function spawnShutdownFixture(
  mode: string,
  collectOutput = true,
  shutdownHooks?: ShutdownPreparationHooks,
): Promise<{
  host: ProcessHost;
  markers: FixtureMarker[];
  outputDone: Promise<void>;
  fixtureDurationMs: number;
}> {
  const configuration = await configurationPromise;
  const limits = configuration.compatibility.limits;
  const fixtureDurationMs = limits.gracefulExitMs +
    limits.terminateExitMs +
    limits.forceExitMs +
    limits.forceExitMs;
  const fixture =
    `${configuration.repositoryRoot}/spikes/codex-app-server/tests/fixtures/fake_app_server.ts`;
  const executable = Deno.execPath();
  const childRunPermissions = [executable, "/usr/bin/python3"].join(",");
  const host = await spawnShutdownProcessHost({
    executable,
    args: [
      "run",
      "--quiet",
      `--allow-run=${childRunPermissions}`,
      fixture,
      mode,
      String(fixtureDurationMs),
    ],
    cwd: configuration.repositoryRoot,
    env: {},
    maxStderrBytes: limits.maxStderrBytes,
    shutdownBounds: {
      gracefulExitMs: limits.gracefulExitMs,
      terminateExitMs: limits.terminateExitMs,
      forceExitMs: limits.forceExitMs,
    },
    shutdownHooks,
  });
  const markers: FixtureMarker[] = [];
  const outputDone = collectOutput
    ? collectFixtureMarkers(host.stdout, markers)
    : Promise.resolve();
  return { host, markers, outputDone, fixtureDurationMs };
}

async function collectFixtureMarkers(
  stream: ReadableStream<Uint8Array>,
  markers: FixtureMarker[],
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) markers.push(JSON.parse(line));
      newline = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  assert(buffered.length === 0, "fixture ended with an incomplete marker");
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

async function waitForMarker(
  markers: FixtureMarker[],
  timeoutMs: number,
): Promise<FixtureMarker> {
  return await waitFor(
    () => Promise.resolve(markers[0]),
    timeoutMs,
    "shutdown fixture did not emit its bounded identity marker",
  );
}

async function processRecord(
  pid: number,
): Promise<DarwinProcessRecord | undefined> {
  return (await readDarwinProcessSnapshot()).find((process) =>
    process.pid === pid
  );
}

async function cleanupPid(pid: number, timeoutMs: number): Promise<void> {
  const output = await new Deno.Command("/bin/kill", {
    args: ["-KILL", "--", String(pid)],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  if (!output.success && await processRecord(pid)) {
    throw new Error(`could not clean up fixture PID ${pid}`);
  }
  await waitFor(
    async () => (await processRecord(pid)) ? undefined : true,
    timeoutMs,
    `cleanup PID ${pid} remained present`,
  );
}

Deno.test("snapshot-only observation can prove absence but never escaped containment", async () => {
  const root = processRecordFixture(101, 101, 101, "Ss");
  const child = processRecordFixture(102, 101, 101, "S");
  let snapshots = 0;
  const provider = () => Promise.resolve(snapshots++ < 2 ? [root, child] : []);
  const identity = await captureOwnedProcessIdentity(101, provider);
  const tree = new DarwinSnapshotProcessTree(identity, provider);
  await tree.observe();
  const final = await tree.observe();
  assertEquals(final.observedPids, [101, 102]);
  assertEquals(final.remainingPids, []);
  assertEquals(final.noObservedDescendantsRemain, true);
  assertEquals(final.capability.facility, "snapshot-only");
  assertEquals(final.capability.available, false);
  assertEquals(final.escapedDescendantContainmentProven, false);
});

Deno.test("negative group signals require an immediate matching positive-root re-read", async () => {
  const identity = { rootPid: 201, processGroupId: 201, sessionId: 201 };
  let signaled: { pid: number; signal: Deno.Signal } | undefined;
  await signalVerifiedProcessGroup(
    identity,
    "SIGTERM",
    () => Promise.resolve([processRecordFixture(201, 1, 201, "Ss")]),
    (pid, signal) => {
      signaled = { pid, signal };
    },
  );
  assertEquals(signaled, { pid: -201, signal: "SIGTERM" });

  let unsafeSignal = false;
  try {
    await signalVerifiedProcessGroup(
      identity,
      "SIGKILL",
      () => Promise.resolve([processRecordFixture(201, 1, 999, "S")]),
      () => {
        unsafeSignal = true;
      },
    );
    throw new Error("expected unsafe process-group rejection");
  } catch (error) {
    assertEquals((error as TransportError).code, "UNSAFE_PROCESS_GROUP");
  }
  assertEquals(unsafeSignal, false);
});

Deno.test("owned-session setup failure is bounded and reaps its launcher child", async () => {
  const configuration = await configurationPromise;
  const limits = configuration.compatibility.limits;
  const startedAt = performance.now();
  let failure: TransportError | undefined;
  try {
    await spawnShutdownProcessHost({
      executable: Deno.execPath(),
      args: ["eval", "await new Promise(() => {})"],
      cwd: configuration.repositoryRoot,
      env: {},
      maxStderrBytes: limits.maxStderrBytes,
      shutdownBounds: {
        gracefulExitMs: limits.gracefulExitMs,
        terminateExitMs: limits.terminateExitMs,
        forceExitMs: limits.forceExitMs,
      },
      sessionLauncher: "/usr/bin/yes",
    });
    throw new Error("expected owned-session setup failure");
  } catch (error) {
    assert(error instanceof TransportError);
    failure = error;
  }
  assertEquals(failure.code, "UNSAFE_PROCESS_GROUP");
  const observed = failure.diagnostic.observed as { rootPid?: number };
  assert(
    Number.isSafeInteger(observed.rootPid) && (observed.rootPid ?? 0) > 0,
    "setup failure did not retain its positive root PID",
  );
  assert(
    performance.now() - startedAt <
      limits.gracefulExitMs + limits.terminateExitMs + limits.forceExitMs,
    "setup failure exceeded the manifest shutdown bounds",
  );
  assertEquals(await processRecord(observed.rootPid!), undefined);
});

Deno.test("unavailable, delayed, lost, and overflowed trackers remain typed blockers", () => {
  assertEquals(
    containmentBlockerCode(SNAPSHOT_ONLY_CAPABILITY),
    "TRACKER_UNAVAILABLE",
  );
  assertEquals(
    containmentBlockerCode({
      ...SNAPSHOT_ONLY_CAPABILITY,
      available: true,
    }),
    "CONTAINMENT_UNPROVEN",
  );
  assertEquals(
    containmentBlockerCode({
      ...SNAPSHOT_ONLY_CAPABILITY,
      available: true,
      lossDetected: true,
    }),
    "TRACKER_LOST",
  );
  assertEquals(
    containmentBlockerCode({
      ...SNAPSHOT_ONLY_CAPABILITY,
      available: true,
      overflowed: true,
    }),
    "TRACKER_OVERFLOWED",
  );
});

Deno.test("concurrent graceful close calls share one promise and fail closed on containment", async () => {
  const hookCalls = {
    stopNewWork: 0,
    settlePending: 0,
    interruptActiveTurn: 0,
  };
  const { host, outputDone } = await spawnShutdownFixture(
    "graceful-exit",
    true,
    {
      stopNewWork: () => {
        hookCalls.stopNewWork++;
      },
      settlePending: () => {
        hookCalls.settlePending++;
      },
      interruptActiveTurn: () => {
        hookCalls.interruptActiveTurn++;
      },
    },
  );
  const first = host.close();
  const second = host.close();
  assert(first === second, "host close did not return its memoized promise");
  const firstError = await assertShutdownError(first, "TRACKER_UNAVAILABLE");
  const secondError = await assertShutdownError(second, "TRACKER_UNAVAILABLE");
  assert(firstError === secondError, "close callers did not share one error");
  assert(
    firstError.evidence === secondError.evidence,
    "close callers did not share one evidence object",
  );
  assertEquals(firstError.evidence.signalPath, ["stdin-close"]);
  assertEquals(firstError.evidence.directExit?.success, true);
  assertEquals(firstError.evidence.noObservedDescendantsRemain, true);
  assertEquals(firstError.evidence.escapedDescendantContainmentProven, false);
  assertEquals(firstError.evidence.containmentCapability.available, false);
  assertEquals(firstError.evidence.drains, {
    stdoutCompleted: true,
    stderrCompleted: true,
  });
  assertEquals(hookCalls, {
    stopNewWork: 1,
    settlePending: 1,
    interruptActiveTurn: 1,
  });
  await outputDone;
});

Deno.test("a never-settling preparation hook times out and cleanup continues", async () => {
  const configuration = await configurationPromise;
  const { host, outputDone } = await spawnShutdownFixture(
    "graceful-exit",
    true,
    { stopNewWork: () => new Promise<void>(() => {}) },
  );
  const error = await assertShutdownError(
    host.close(),
    "TRACKER_UNAVAILABLE",
  );
  assert(
    error.evidence.diagnostics.some((diagnostic) =>
      diagnostic.code === "GRACEFUL_SHUTDOWN_TIMEOUT" &&
      diagnostic.stage === "shutdown.prepare.stop-new-work"
    ),
    "never-settling preparation did not retain typed timeout evidence",
  );
  assertEquals(error.evidence.signalPath, ["stdin-close"]);
  assertEquals(error.evidence.directExit?.success, true);
  assertEquals(error.evidence.remainingPids, []);
  assert(
    error.evidence.timings.totalMs <
      configuration.compatibility.limits.gracefulExitMs +
        configuration.compatibility.limits.terminateExitMs,
    "preparation timeout did not preserve bounded cleanup",
  );
  await outputDone;
});

Deno.test("ignored stdin escalates to verified process-group SIGTERM", async () => {
  const { host, outputDone } = await spawnShutdownFixture(
    "ignore-stdin-close",
  );
  const error = await assertShutdownError(
    host.close(),
    "TRACKER_UNAVAILABLE",
  );
  assertEquals(error.evidence.signalPath, ["stdin-close", "SIGTERM"]);
  assertEquals(error.evidence.timedOutStages, ["graceful"]);
  assertEquals(error.evidence.directExit?.signal, "SIGTERM");
  assertEquals(error.evidence.remainingPids, []);
  await outputDone;
});

Deno.test("ignored SIGTERM escalates to verified process-group SIGKILL", async () => {
  const { host, outputDone } = await spawnShutdownFixture("ignore-signals");
  const error = await assertShutdownError(
    host.close(),
    "TRACKER_UNAVAILABLE",
  );
  assertEquals(error.evidence.signalPath, [
    "stdin-close",
    "SIGTERM",
    "SIGKILL",
  ]);
  assertEquals(error.evidence.timedOutStages, ["graceful", "terminate"]);
  assertEquals(error.evidence.directExit?.signal, "SIGKILL");
  assertEquals(error.evidence.remainingPids, []);
  await outputDone;
});

Deno.test("ordinary grandchildren are observed and terminated with their owned group", async () => {
  const configuration = await configurationPromise;
  const { host, markers, outputDone } = await spawnShutdownFixture(
    "ordinary-grandchild",
  );
  const marker = await waitForMarker(
    markers,
    configuration.compatibility.limits.gracefulExitMs,
  );
  const error = await assertShutdownError(
    host.close(),
    "TRACKER_UNAVAILABLE",
  );
  assertEquals(marker.kind, "ordinary");
  assert(error.evidence.observedPids.includes(marker.pid));
  assertEquals(error.evidence.signalPath, ["stdin-close", "SIGTERM"]);
  assertEquals(error.evidence.remainingPids, []);
  assertEquals(await processRecord(marker.pid), undefined);
  await outputDone;
});

Deno.test("protocol failure, timeout, unexpected request, child exit, and cancellation reuse close evidence", async () => {
  const [configuration, validator] = await Promise.all([
    configurationPromise,
    validatorPromise,
  ]);
  const cases = [
    {
      mode: "malformed-json",
      expectedFailure: "JSON_INVALID",
      trigger: async (client: JsonlClient) => {
        await client.request("initialize", initializeParams);
        await client.notify("initialized");
        await client.done;
      },
    },
    {
      mode: "no-response",
      expectedFailure: "REQUEST_TIMEOUT",
      trigger: async (client: JsonlClient) => {
        await client.request("initialize", initializeParams);
        await client.notify("initialized");
        await client.request("account/read", {});
      },
    },
    {
      mode: "unknown-server-request",
      expectedFailure: "UNKNOWN_SERVER_REQUEST",
      trigger: async (client: JsonlClient) => {
        await client.request("initialize", initializeParams);
        await client.notify("initialized");
        await client.done;
      },
    },
    {
      mode: "early-eof",
      expectedFailure: "PROCESS_EXITED",
      trigger: async (client: JsonlClient) => {
        await client.request("initialize", initializeParams);
        await client.notify("initialized");
        await client.done;
      },
    },
    {
      mode: "graceful-exit",
      expectedFailure: undefined,
      trigger: (_client: JsonlClient) => Promise.resolve(),
    },
  ] as const;

  for (const testCase of cases) {
    const { host } = await spawnShutdownFixture(testCase.mode, false);
    const client = JsonlClient.connect({
      host,
      validator,
      recorder: new TranscriptRecorder(),
      limits: {
        maxStdoutLineBytes:
          configuration.compatibility.limits.maxStdoutLineBytes,
        maxQueueMessages: configuration.compatibility.limits.maxQueueMessages,
        maxQueueBytes: configuration.compatibility.limits.maxQueueBytes,
        requestTimeoutMs: configuration.compatibility.limits.gracefulExitMs,
      },
    });
    if (testCase.expectedFailure) {
      try {
        await testCase.trigger(client);
        throw new Error(`expected ${testCase.expectedFailure}`);
      } catch (error) {
        assertEquals((error as TransportError).code, testCase.expectedFailure);
      }
    } else {
      await testCase.trigger(client);
    }
    const first = client.close();
    const second = client.close();
    assert(first === second, `${testCase.mode} did not memoize client close`);
    let firstError: ShutdownError | undefined;
    try {
      await first;
    } catch (error) {
      assert(error instanceof ShutdownError);
      firstError = error;
    }
    assert(firstError);
    assertEquals(
      firstError.code,
      "TRACKER_UNAVAILABLE",
      `${testCase.mode} shutdown diagnostics ${
        firstError.evidence.diagnostics.map((diagnostic) =>
          `${diagnostic.code}@${diagnostic.stage}`
        ).join(",")
      }`,
    );
    const secondError = await assertShutdownError(
      second,
      "TRACKER_UNAVAILABLE",
    );
    assert(firstError.evidence === secondError.evidence);
    assertEquals(firstError.evidence.noObservedDescendantsRemain, true);
    assertEquals(firstError.evidence.drains, {
      stdoutCompleted: true,
      stderrCompleted: true,
    });
  }
});

Deno.test("a surviving grandchild is a typed leak and cannot be converted into proof", async () => {
  const configuration = await configurationPromise;
  const { host, markers, outputDone } = await spawnShutdownFixture(
    "surviving-grandchild",
  );
  const marker = await waitForMarker(
    markers,
    configuration.compatibility.limits.gracefulExitMs,
  );
  try {
    const error = await assertShutdownError(host.close(), "DESCENDANT_LEAK");
    assertEquals(error.evidence.signalPath, ["stdin-close"]);
    assert(error.evidence.remainingPids.includes(marker.pid));
    assertEquals(error.evidence.noObservedDescendantsRemain, false);
    assertEquals(error.evidence.escapedDescendantContainmentProven, false);
  } finally {
    await cleanupPid(
      marker.pid,
      configuration.compatibility.limits.forceExitMs,
    );
    await outputDone;
  }
});

Deno.test("the real immediate setsid/reparent escape remains a fail-closed blocker", async () => {
  const configuration = await configurationPromise;
  const { host, markers, outputDone } = await spawnShutdownFixture(
    "immediate-session-escape",
  );
  const marker = await waitForMarker(
    markers,
    configuration.compatibility.limits.gracefulExitMs,
  );
  try {
    const escaped = await waitFor(
      async () => {
        const process = await processRecord(marker.pid);
        return process !== undefined &&
            process.pid === process.processGroupId &&
            process.state.includes("s")
          ? process
          : undefined;
      },
      configuration.compatibility.limits.gracefulExitMs,
      "escape worker never became a real setsid session leader",
    );
    assertEquals(escaped.processGroupId, marker.pid);
    assert(host.ownedIdentity);
    assert(escaped.processGroupId !== host.ownedIdentity.processGroupId);

    const error = await assertShutdownError(host.close(), "DESCENDANT_LEAK");
    const reparented = await waitFor(
      async () => {
        const process = await processRecord(marker.pid);
        return process && process.parentPid !== host.pid ? process : undefined;
      },
      configuration.compatibility.limits.forceExitMs,
      "escape worker did not outlive and reparent away from the direct child",
    );
    assertEquals(reparented.pid, marker.pid);
    assert(error.evidence.observedPids.includes(marker.pid));
    assert(error.evidence.remainingPids.includes(marker.pid));
    assertEquals(
      error.evidence.containmentCapability.facility,
      "snapshot-only",
    );
    assertEquals(error.evidence.containmentCapability.available, false);
    assertEquals(
      error.evidence.containmentCapability.armedBeforeChildExecution,
      false,
    );
    assertEquals(error.evidence.escapedDescendantContainmentProven, false);
    assert(
      error.evidence.diagnostics.some((diagnostic) =>
        diagnostic.code === "TRACKER_UNAVAILABLE"
      ),
    );
  } finally {
    await cleanupPid(
      marker.pid,
      configuration.compatibility.limits.forceExitMs,
    );
    await outputDone;
  }
});

function processRecordFixture(
  pid: number,
  parentPid: number,
  processGroupId: number,
  state: string,
): DarwinProcessRecord {
  return {
    pid,
    parentPid,
    processGroupId,
    auditSessionId: 0,
    state,
    command: "fixture",
  };
}

const initializeParams = {
  clientInfo: {
    name: "vantage-shutdown-test",
    version: "1",
  },
};
