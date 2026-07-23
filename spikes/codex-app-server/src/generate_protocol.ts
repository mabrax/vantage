import {
  compareGeneratedTrees,
  ContractError,
  hashGeneratedTree,
  listGeneratedFiles,
  loadConfiguration,
  ORDERING_EXCEPTION,
  type RegenerationVerifiedConfiguration,
} from "./config.ts";
import {
  extractStableSurface,
  validateCoverageMembership,
} from "./coverage.ts";

type Mode = "generate" | "verify";

function parseArguments(args: string[]): { mode: Mode; codex: string } {
  const mode = args[0];
  if (mode !== "generate" && mode !== "verify") {
    throw new ContractError(
      "GENERATOR_USAGE",
      "usage: generate_protocol.ts <generate|verify> --codex <absolute-path>",
    );
  }
  const codexFlag = args.indexOf("--codex");
  const codex = codexFlag >= 0 ? args[codexFlag + 1] : undefined;
  if (!codex || !codex.startsWith("/")) {
    throw new ContractError(
      "CODEX_PATH_INVALID",
      "the pinned Codex executable must be supplied as an absolute path",
    );
  }
  return { mode, codex };
}

async function requirePinnedCodex(
  codex: string,
  expectedOutput: string,
): Promise<void> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(codex, {
      args: ["--version"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new ContractError(
        "CODEX_NOT_FOUND",
        `Codex executable not found at ${codex}`,
      );
    }
    throw error;
  }
  const observed = new TextDecoder().decode(output.stdout).trim();
  if (!output.success || observed !== expectedOutput) {
    throw new ContractError(
      "CODEX_VERSION_MISMATCH",
      `expected ${expectedOutput}, observed ${observed || "<no stdout>"}`,
      { expected: expectedOutput, observed, executable: codex },
    );
  }
}

async function runGenerator(
  codex: string,
  args: readonly string[],
  outputPath: string,
): Promise<void> {
  if (
    args.includes("--experimental") ||
    args.some((arg) => arg.startsWith("--enable"))
  ) {
    throw new ContractError(
      "EXPERIMENTAL_GENERATION_FORBIDDEN",
      "stable protocol generation cannot enable experimental output",
    );
  }
  const expanded = args.map((arg) => arg === "{output}" ? outputPath : arg);
  const output = await new Deno.Command(codex, {
    args: expanded,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new ContractError(
      "GENERATOR_FAILED",
      `${expanded.slice(0, 2).join(" ")} exited ${output.code}`,
      {
        stderr: new TextDecoder().decode(output.stderr).slice(-4096),
      },
    );
  }
}

async function freshGeneration(
  parent: string,
  codex: string,
  commands: {
    types: readonly string[];
    jsonSchema: readonly string[];
  },
): Promise<string> {
  const root = await Deno.makeTempDir({
    dir: parent,
    prefix: "codex-protocol-0.145.0-",
  });
  await runGenerator(codex, commands.types, `${root}/types`);
  await runGenerator(codex, commands.jsonSchema, `${root}/json-schema`);
  return root;
}

async function verifyOneFreshTree(
  committedRoot: string,
  freshRoot: string,
  expectedCounts: { types: number; jsonSchema: number },
  expectedRegenerationHash: string,
): Promise<void> {
  const comparison = await compareGeneratedTrees(committedRoot, freshRoot, {
    onRawDiff: (path) => console.error(`raw generated difference: ${path}`),
  });
  if (
    comparison.fileCounts.types !== expectedCounts.types ||
    comparison.fileCounts.jsonSchema !== expectedCounts.jsonSchema
  ) {
    throw new ContractError(
      "GENERATED_FILE_COUNT_MISMATCH",
      "fresh generation file counts differ from committed metadata",
      { expected: expectedCounts, observed: comparison.fileCounts },
    );
  }
  if (comparison.regenerationSha256 !== expectedRegenerationHash) {
    throw new ContractError(
      "REGENERATION_HASH_MISMATCH",
      "fresh generation differs from recorded regeneration hash",
      {
        expected: expectedRegenerationHash,
        observed: comparison.regenerationSha256,
      },
    );
  }
  if (
    comparison.rawDiffs.some((path) => path !== ORDERING_EXCEPTION) ||
    comparison.rawDiffs.length > 1
  ) {
    throw new ContractError(
      "ORDERING_EXCEPTION_SCOPE_VIOLATION",
      "raw differences exceed the single named ordering exception",
      { rawDiffs: comparison.rawDiffs },
    );
  }
}

export async function verifyProtocol(
  codex: string,
  freshGenerationCount = 1,
): Promise<RegenerationVerifiedConfiguration> {
  if (!Number.isInteger(freshGenerationCount) || freshGenerationCount < 1) {
    throw new ContractError(
      "REGENERATION_COUNT_INVALID",
      "protocol verification requires at least one fresh generation",
    );
  }
  const config = await loadConfiguration();
  await requirePinnedCodex(codex, config.compatibility.codex.versionOutput);
  const surface = await extractStableSurface(
    `${config.generatedRoot}/json-schema`,
  );
  validateCoverageMembership(config.coverage, surface);
  const committedRawHash = await hashGeneratedTree(config.generatedRoot, "raw");
  if (committedRawHash !== config.generation.bundleSha256) {
    throw new ContractError(
      "COMMITTED_BUNDLE_HASH_MISMATCH",
      "the committed generated bytes do not match generation metadata",
    );
  }
  const freshRoots: string[] = [];
  try {
    for (let run = 0; run < freshGenerationCount; run++) {
      const root = await freshGeneration(
        "/tmp",
        codex,
        config.generation.commands,
      );
      freshRoots.push(root);
      await verifyOneFreshTree(
        config.generatedRoot,
        root,
        config.generation.fileCounts,
        config.generation.regenerationSha256,
      );
    }
    if (freshRoots.length > 1) {
      await verifyOneFreshTree(
        freshRoots[0],
        freshRoots[1],
        config.generation.fileCounts,
        config.generation.regenerationSha256,
      );
    }
  } finally {
    await Promise.all(
      freshRoots.map((root) =>
        Deno.remove(root, { recursive: true }).catch(() => {})
      ),
    );
  }
  return { ...config, generatedArtifactsMatch: true };
}

export async function generateProtocol(codex: string): Promise<void> {
  const config = await loadConfiguration();
  await requirePinnedCodex(codex, config.compatibility.codex.versionOutput);
  const generatedParent = config.generatedRoot.replace(/\/[^/]+$/, "");
  const freshRoot = await freshGeneration(
    generatedParent,
    codex,
    config.generation.commands,
  );
  try {
    await verifyOneFreshTree(
      config.generatedRoot,
      freshRoot,
      config.generation.fileCounts,
      config.generation.regenerationSha256,
    );
    // The exact committed raw bytes are immutable identity. When a fresh stable
    // generation is equivalent under the one allowed ordering exception, retain
    // the selected snapshot rather than replacing it with different raw ordering.
    console.log(
      "fresh stable generation is equivalent; preserved committed generated bytes",
    );
  } finally {
    await Deno.remove(freshRoot, { recursive: true }).catch(() => {});
  }
}

if (import.meta.main) {
  try {
    const { mode, codex } = parseArguments(Deno.args);
    const config = mode === "generate"
      ? (await generateProtocol(codex), await loadConfiguration())
      : await verifyProtocol(codex, 1);
    const files = await listGeneratedFiles(config.generatedRoot);
    console.log(
      `verified ${
        files.filter((file) => file.path.startsWith("types/")).length
      } TypeScript and ${
        files.filter((file) => file.path.startsWith("json-schema/")).length
      } JSON Schema files`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
