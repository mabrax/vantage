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
} from "../src/config.ts";
import { verifyProtocol } from "../src/generate_protocol.ts";
import { validateJsonAgainstSchema } from "../src/protocol_validation.ts";

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
