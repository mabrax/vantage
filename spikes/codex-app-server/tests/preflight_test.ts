import {
  type CompatibilityManifest,
  ContractError,
  loadConfiguration,
} from "../src/config.ts";
import {
  LifecycleScenarioError,
  runLifecycleScenario,
} from "../src/lifecycle_scenario.ts";
import { JsonlClient } from "../src/jsonl_client.ts";
import {
  PreflightError,
  requireAuthenticatedAccount,
  runStaticPreflight,
} from "../src/preflight.ts";
import { spawnProcessHost } from "../src/process_host.ts";
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

async function assertRejectsCode(
  operation: Promise<unknown> | (() => Promise<unknown>),
  code: string,
): Promise<Error> {
  try {
    await (typeof operation === "function" ? operation() : operation);
  } catch (error) {
    assert(
      error instanceof Error && error.message.startsWith(`${code}:`),
      `expected ${code}, received ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return error;
  }
  throw new Error(`expected ${code}`);
}

const configurationPromise = loadConfiguration();
const validatorPromise = configurationPromise.then((configuration) =>
  ProtocolValidator.load(`${configuration.generatedRoot}/json-schema`)
);

async function lifecycleFactory(
  mode: string,
  onRecorder?: (recorder: TranscriptRecorder) => void,
) {
  const [configuration, validator] = await Promise.all([
    configurationPromise,
    validatorPromise,
  ]);
  return (_repositoryPath: string) => {
    const recorder = new TranscriptRecorder();
    onRecorder?.(recorder);
    const host = spawnProcessHost({
      executable: Deno.execPath().split("/").at(-1)!,
      args: [
        "run",
        "--quiet",
        `${configuration.repositoryRoot}/spikes/codex-app-server/tests/fixtures/fake_app_server.ts`,
        mode,
      ],
      cwd: configuration.repositoryRoot,
      env: {},
      maxStderrBytes: configuration.compatibility.limits.maxStderrBytes,
    });
    return Promise.resolve(JsonlClient.connect({
      host,
      validator,
      recorder,
      limits: {
        maxStdoutLineBytes:
          configuration.compatibility.limits.maxStdoutLineBytes,
        maxQueueMessages: configuration.compatibility.limits.maxQueueMessages,
        maxQueueBytes: configuration.compatibility.limits.maxQueueBytes,
        requestTimeoutMs: configuration.compatibility.limits.initializeMs,
      },
    }));
  };
}

function withLimits(
  compatibility: CompatibilityManifest,
  limits: Record<string, number>,
): CompatibilityManifest {
  return {
    ...compatibility,
    limits: { ...compatibility.limits, ...limits },
  };
}

Deno.test("developer launcher reports missing Deno with the exact recovery contract", async () => {
  const configuration = await configurationPromise;
  const script = `${configuration.repositoryRoot}/scripts/run-protocol-spike`;
  const status = await Deno.stat(script);
  assert((status.mode ?? 0) & 0o100, "launcher is not executable");
  const output = await new Deno.Command("/bin/sh", {
    args: [script],
    clearEnv: true,
    env: { PATH: "/definitely/missing" },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(output.code, 127);
  const diagnostic = JSON.parse(new TextDecoder().decode(output.stderr));
  assertEquals(diagnostic.code, "DENO_NOT_FOUND");
  assertEquals(diagnostic.expected, "2.9.3");
  assert(String(diagnostic.nextAction).includes("Deno 2.9.3"));
});

Deno.test("static preflight maps exact Deno, Codex, artifact, and platform failures", async () => {
  const configuration = await configurationPromise;
  const verified = () => Promise.resolve(configuration);
  const exactCodex = (executable: string) =>
    Promise.resolve({
      output: "codex-cli 0.145.0",
      executablePath: executable,
    });

  const denoError = await assertRejectsCode(
    runStaticPreflight({
      denoVersion: "2.9.2",
      verifyArtifacts: verified,
      probeCodexVersion: exactCodex,
    }),
    "DENO_VERSION_MISMATCH",
  ) as PreflightError;
  assertEquals(denoError.diagnostic.expected, "2.9.3");

  const missing = await assertRejectsCode(
    runStaticPreflight({
      verifyArtifacts: verified,
      probeCodexVersion: () =>
        Promise.reject(new Deno.errors.NotFound("missing")),
    }),
    "CODEX_NOT_FOUND",
  ) as PreflightError;
  assertEquals(missing.diagnostic.stage, "preflight.codex.resolve");

  const mismatch = await assertRejectsCode(
    runStaticPreflight({
      verifyArtifacts: verified,
      probeCodexVersion: () =>
        Promise.resolve({
          output: "codex-cli 0.144.0",
          executablePath: "/fake/codex",
        }),
    }),
    "CODEX_VERSION_MISMATCH",
  ) as PreflightError;
  assertEquals(mismatch.diagnostic.executablePath, "/fake/codex");

  await assertRejectsCode(
    runStaticPreflight({
      verifyArtifacts: () =>
        Promise.reject(new ContractError("HASH_CHANGED", "fixture")),
      probeCodexVersion: exactCodex,
    }),
    "ARTIFACT_MISMATCH",
  );

  await assertRejectsCode(
    runStaticPreflight({
      mode: "spike:verify",
      platform: { os: "linux", arch: "x86_64" },
      verifyArtifacts: verified,
      probeCodexVersion: exactCodex,
    }),
    "PLATFORM_UNSUPPORTED",
  );
  const deterministic = await runStaticPreflight({
    mode: "deterministic",
    platform: { os: "linux", arch: "x86_64" },
    verifyArtifacts: verified,
    probeCodexVersion: exactCodex,
  });
  assertEquals(deterministic.platform, { os: "linux", arch: "x86_64" });
});

Deno.test("account policy rejects only null accounts and accepts requiresOpenaiAuth true", async () => {
  await assertRejectsCode(
    Promise.resolve().then(() =>
      requireAuthenticatedAccount({
        account: null,
        requiresOpenaiAuth: true,
      })
    ),
    "CODEX_AUTH_REQUIRED",
  );
  assertEquals(
    requireAuthenticatedAccount({
      account: { type: "apiKey" },
      requiresOpenaiAuth: true,
    }),
    { type: "apiKey" },
  );
});

Deno.test("failed authentication writes no model, thread, or turn request", async () => {
  const configuration = await configurationPromise;
  let recorder: TranscriptRecorder | undefined;
  await assertRejectsCode(
    runLifecycleScenario({
      compatibility: configuration.compatibility,
      createClient: await lifecycleFactory(
        "lifecycle-account-null",
        (value) => recorder = value,
      ),
    }),
    "CODEX_AUTH_REQUIRED",
  );
  const clientMethods =
    recorder?.records.filter((record) => record.direction === "client").map((
      record,
    ) => record.direction === "client" ? record.method : "") ?? [];
  assertEquals(clientMethods, ["initialize", "initialized", "account/read"]);
});

Deno.test("model pagination accepts absent and null terminal cursors", async () => {
  const configuration = await configurationPromise;
  for (
    const [mode, pages] of [
      ["lifecycle-cursor-absent", 1],
      ["lifecycle-cursor-null", 1],
      ["full-lifecycle", 2],
      ["lifecycle-auth-flag", 2],
    ] as const
  ) {
    const result = await runLifecycleScenario({
      compatibility: configuration.compatibility,
      createClient: await lifecycleFactory(mode),
    });
    assertEquals(result.modelPages, pages);
    assertEquals(result.terminalStatus, "completed");
  }
});

Deno.test("repeated cursors and page exhaustion stop before thread creation", async () => {
  const configuration = await configurationPromise;
  for (
    const [mode, code, compatibility] of [
      [
        "lifecycle-repeated-cursor",
        "MODEL_CURSOR_REPEATED",
        configuration.compatibility,
      ],
      [
        "lifecycle-endless-pages",
        "MODEL_PAGE_EXHAUSTED",
        withLimits(configuration.compatibility, { maxModelPages: 2 }),
      ],
    ] as const
  ) {
    let recorder: TranscriptRecorder | undefined;
    await assertRejectsCode(
      runLifecycleScenario({
        compatibility,
        createClient: await lifecycleFactory(
          mode,
          (value) => recorder = value,
        ),
      }),
      code,
    );
    assert(
      !recorder?.records.some((record) =>
        record.direction === "client" &&
        (record.method === "thread/start" || record.method === "turn/start")
      ),
      `${mode} wrote authenticated work after catalog failure`,
    );
  }
});

Deno.test("catalog deadline stops before model and thread creation", async () => {
  const configuration = await configurationPromise;
  let recorder: TranscriptRecorder | undefined;
  let calls = 0;
  await assertRejectsCode(
    runLifecycleScenario({
      compatibility: withLimits(configuration.compatibility, {
        modelCatalogMs: 10,
      }),
      createClient: await lifecycleFactory(
        "full-lifecycle",
        (value) => recorder = value,
      ),
      now: () => calls++ === 0 ? 0 : 11,
    }),
    "MODEL_CATALOG_DEADLINE",
  );
  assert(
    !recorder?.records.some((record) =>
      record.direction === "client" &&
      (record.method === "model/list" || record.method === "thread/start")
    ),
  );
});

Deno.test("thread and turn start only after complete bounded catalog enumeration", async () => {
  const configuration = await configurationPromise;
  let recorder: TranscriptRecorder | undefined;
  const result = await runLifecycleScenario({
    compatibility: configuration.compatibility,
    createClient: await lifecycleFactory(
      "full-lifecycle",
      (value) => recorder = value,
    ),
  });
  assert(result.agentText.length > 0);
  const methods = recorder!.records.filter((record) =>
    record.direction === "client"
  ).map((record) => record.direction === "client" ? record.method : "");
  assertEquals(
    methods.filter((method) => method === "initialize").length,
    1,
  );
  const modelIndexes = methods.flatMap((method, index) =>
    method === "model/list" ? [index] : []
  );
  assert(modelIndexes.length === 2);
  assert(Math.max(...modelIndexes) < methods.indexOf("thread/start"));
  assert(methods.indexOf("thread/start") < methods.indexOf("turn/start"));
});

Deno.test("lifecycle scenario failures retain stable error types", () => {
  const error = new LifecycleScenarioError("FIXTURE", "fixture");
  assertEquals(error.code, "FIXTURE");
});
