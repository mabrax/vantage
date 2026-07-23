import { validateJsonAgainstSchema } from "./protocol_validation.ts";

export const ORDERING_EXCEPTION =
  "json-schema/codex_app_server_protocol.v2.schemas.json";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class ContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "ContractError";
  }
}

export type CompatibilityManifest = {
  schemaVersion: 1;
  deno: { version: "2.9.3" };
  codex: {
    cliVersion: "0.145.0";
    versionOutput: "codex-cli 0.145.0";
    appServerArgs: ["app-server", "--stdio"];
  };
  generation: {
    mode: "stable";
    typesCommand: ["app-server", "generate-ts", "--out", "{output}"];
    jsonSchemaCommand: [
      "app-server",
      "generate-json-schema",
      "--out",
      "{output}",
    ];
    generatedRoot: "spikes/codex-app-server/generated/0.145.0";
    bundleSha256: string;
  };
  validationPlatform: {
    os: "darwin";
    arch: "aarch64";
    cleanupStrategy: "unix-process-group-v1";
  };
  limits: Record<string, number>;
};

export type GenerationMetadata = {
  schemaVersion: 1;
  codexVersion: "0.145.0";
  codexVersionOutput: "codex-cli 0.145.0";
  experimental: false;
  commands: {
    types: ["app-server", "generate-ts", "--out", "{output}"];
    jsonSchema: [
      "app-server",
      "generate-json-schema",
      "--out",
      "{output}",
    ];
  };
  generatedAt: string;
  fileCounts: { types: number; jsonSchema: number };
  bundleSha256: string;
  regenerationSha256: string;
  orderingException: typeof ORDERING_EXCEPTION;
};

export type CoverageDisposition =
  | "exercised"
  | "schema-validated-unexercised"
  | "intentionally-ignored"
  | "unsupported";

export type ProtocolDirection =
  | "client-request"
  | "client-notification"
  | "server-notification"
  | "server-request";

export type CoverageEntry = {
  direction: ProtocolDirection;
  method: string;
  disposition: CoverageDisposition;
  rationale: string;
  observedCount: number;
};

export type CoverageManifest = {
  schemaVersion: 1;
  codexVersion: "0.145.0";
  generatorMode: "stable";
  generatedBundleSha256: string;
  entries: CoverageEntry[];
};

export type LoadedConfiguration = {
  repositoryRoot: string;
  compatibilityPath: string;
  coveragePath: string;
  generatedRoot: string;
  compatibility: CompatibilityManifest;
  generation: GenerationMetadata;
  coverage: CoverageManifest;
  immutableInputsVerified: true;
  generatedArtifactsMatch: false;
};

export type RegenerationVerifiedConfiguration =
  & Omit<LoadedConfiguration, "generatedArtifactsMatch">
  & { generatedArtifactsMatch: true };

export type GeneratedFile = {
  path: string;
  bytes: Uint8Array;
};

function trimTrailingSlashes(path: string): string {
  return path === "/" ? path : path.replace(/\/+$/, "");
}

function pathFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname);
}

export function joinPath(root: string, ...parts: string[]): string {
  const base = new URL(`file://${trimTrailingSlashes(root)}/`);
  let url = base;
  for (const part of parts) {
    url = new URL(
      part.replace(/^\/+/, ""),
      url.href.endsWith("/") ? url : new URL("./", url),
    );
  }
  return pathFromUrl(url);
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = trimTrailingSlashes(root);
  return candidate === normalizedRoot ||
    candidate.startsWith(`${normalizedRoot}/`);
}

export async function discoverRepositoryRoot(
  start = pathFromUrl(new URL(".", import.meta.url)),
): Promise<string> {
  let current = trimTrailingSlashes(await Deno.realPath(start));
  while (true) {
    try {
      const info = await Deno.stat(`${current}/deno.json`);
      if (info.isFile) return current;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const parent = current.replace(/\/[^/]+$/, "") || "/";
    if (parent === current) {
      throw new ContractError(
        "REPOSITORY_ROOT_NOT_FOUND",
        `could not discover repository root from ${start}`,
      );
    }
    current = parent;
  }
}

export async function resolveRepositoryPath(
  repositoryRoot: string,
  relativePath: string,
  options: { mustExist?: boolean } = { mustExist: true },
): Promise<string> {
  if (
    relativePath.length === 0 || relativePath.startsWith("/") ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new ContractError(
      "PATH_ESCAPE",
      `path must be non-empty and repository-relative: ${relativePath}`,
    );
  }
  const canonicalRelative = relativePath.replaceAll("\\", "/");
  const candidate = joinPath(repositoryRoot, canonicalRelative);
  if (!isWithin(repositoryRoot, candidate)) {
    throw new ContractError(
      "PATH_ESCAPE",
      `path escapes repository: ${relativePath}`,
    );
  }
  try {
    const real = await Deno.realPath(candidate);
    if (!isWithin(repositoryRoot, real)) {
      throw new ContractError(
        "SYMLINK_ESCAPE",
        `path resolves outside repository: ${relativePath}`,
      );
    }
    return real;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound && options.mustExist === false) {
      const parent = candidate.replace(/\/[^/]+$/, "");
      const realParent = await Deno.realPath(parent);
      if (!isWithin(repositoryRoot, realParent)) {
        throw new ContractError(
          "SYMLINK_ESCAPE",
          `path parent resolves outside repository: ${relativePath}`,
        );
      }
      return candidate;
    }
    throw error;
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return [...new Uint8Array(digest)].map((value) =>
    value.toString(16).padStart(2, "0")
  )
    .join("");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((
        key,
      ) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(canonicalValue(value))}\n`);
}

export async function hashCanonicalJson(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJsonBytes(value));
}

class StrictJsonParser {
  #index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.#skipWhitespace();
    const value = this.#parseValue();
    this.#skipWhitespace();
    if (this.#index !== this.source.length) this.#fail("trailing content");
    return value;
  }

  #parseValue(): unknown {
    const char = this.source[this.#index];
    if (char === "{") return this.#parseObject();
    if (char === "[") return this.#parseArray();
    if (char === '"') return this.#parseString();
    if (char === "t") return this.#parseLiteral("true", true);
    if (char === "f") return this.#parseLiteral("false", false);
    if (char === "n") return this.#parseLiteral("null", null);
    return this.#parseNumber();
  }

  #parseObject(): Record<string, unknown> {
    this.#index++;
    this.#skipWhitespace();
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (this.source[this.#index] === "}") {
      this.#index++;
      return result;
    }
    while (true) {
      if (this.source[this.#index] !== '"') this.#fail("expected object key");
      const key = this.#parseString();
      if (keys.has(key)) {
        throw new ContractError(
          "DUPLICATE_JSON_KEY",
          `duplicate object key ${JSON.stringify(key)}`,
          { key },
        );
      }
      keys.add(key);
      this.#skipWhitespace();
      if (this.source[this.#index++] !== ":") this.#fail("expected ':'");
      this.#skipWhitespace();
      result[key] = this.#parseValue();
      this.#skipWhitespace();
      const delimiter = this.source[this.#index++];
      if (delimiter === "}") return result;
      if (delimiter !== ",") this.#fail("expected ',' or '}'");
      this.#skipWhitespace();
    }
  }

  #parseArray(): unknown[] {
    this.#index++;
    this.#skipWhitespace();
    const result: unknown[] = [];
    if (this.source[this.#index] === "]") {
      this.#index++;
      return result;
    }
    while (true) {
      result.push(this.#parseValue());
      this.#skipWhitespace();
      const delimiter = this.source[this.#index++];
      if (delimiter === "]") return result;
      if (delimiter !== ",") this.#fail("expected ',' or ']'");
      this.#skipWhitespace();
    }
  }

  #parseString(): string {
    const start = this.#index;
    this.#index++;
    let escaped = false;
    while (this.#index < this.source.length) {
      const code = this.source.charCodeAt(this.#index);
      if (!escaped && code === 0x22) {
        this.#index++;
        try {
          return JSON.parse(this.source.slice(start, this.#index));
        } catch {
          this.#fail("invalid string");
        }
      }
      if (!escaped && code < 0x20) this.#fail("unescaped control character");
      if (!escaped && code === 0x5c) {
        escaped = true;
      } else {
        escaped = false;
      }
      this.#index++;
    }
    this.#fail("unterminated string");
  }

  #parseNumber(): number {
    const remainder = this.source.slice(this.#index);
    const match = remainder.match(
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/,
    );
    if (!match) this.#fail("expected JSON value");
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.#fail("non-finite number");
    return value;
  }

  #parseLiteral<T>(text: string, value: T): T {
    if (this.source.slice(this.#index, this.#index + text.length) !== text) {
      this.#fail(`expected ${text}`);
    }
    this.#index += text.length;
    return value;
  }

  #skipWhitespace(): void {
    while (/[\t\n\r ]/.test(this.source[this.#index] ?? "")) this.#index++;
  }

  #fail(reason: string): never {
    throw new ContractError(
      "INVALID_JSON",
      `${reason} at byte-like character offset ${this.#index}`,
    );
  }
}

export function parseJsonRejectDuplicateKeys(
  bytes: Uint8Array | string,
): unknown {
  const source = typeof bytes === "string" ? bytes : decoder.decode(bytes);
  return new StrictJsonParser(source).parse();
}

async function walkFiles(
  root: string,
  relative = "",
  files: GeneratedFile[] = [],
): Promise<GeneratedFile[]> {
  const directory = relative ? `${root}/${relative}` : root;
  const entries = [];
  for await (const entry of Deno.readDir(directory)) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymlink) {
      throw new ContractError(
        "GENERATED_SYMLINK",
        `generated tree contains symlink ${path}`,
      );
    }
    if (entry.isDirectory) {
      await walkFiles(root, path, files);
    } else if (entry.isFile) {
      files.push({
        path: path.replaceAll("\\", "/"),
        bytes: await Deno.readFile(`${root}/${path}`),
      });
    }
  }
  return files;
}

export async function listGeneratedFiles(
  generatedRoot: string,
): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  for (const tree of ["types", "json-schema"]) {
    const treeFiles = await walkFiles(`${generatedRoot}/${tree}`);
    for (const file of treeFiles) {
      files.push({ path: `${tree}/${file.path}`, bytes: file.bytes });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function framedRecord(path: string, bytes: Uint8Array): Uint8Array {
  return concatBytes([
    encoder.encode(path),
    new Uint8Array([0]),
    bytes,
    new Uint8Array([0]),
  ]);
}

export async function hashGeneratedFiles(
  files: GeneratedFile[],
  mode: "raw" | "regeneration",
): Promise<string> {
  const records = [];
  for (
    const file of [...files].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
  ) {
    let bytes = file.bytes;
    if (mode === "regeneration" && file.path === ORDERING_EXCEPTION) {
      bytes = canonicalJsonBytes(parseJsonRejectDuplicateKeys(file.bytes));
    }
    records.push(framedRecord(file.path, bytes));
  }
  return await sha256Hex(concatBytes(records));
}

export async function hashGeneratedTree(
  generatedRoot: string,
  mode: "raw" | "regeneration",
): Promise<string> {
  return await hashGeneratedFiles(
    await listGeneratedFiles(generatedRoot),
    mode,
  );
}

export type GeneratedComparison = {
  fileCounts: { types: number; jsonSchema: number };
  rawDiffs: string[];
  regenerationSha256: string;
};

export async function compareGeneratedTrees(
  committedRoot: string,
  regeneratedRoot: string,
  options: { onRawDiff?: (path: string) => void } = {},
): Promise<GeneratedComparison> {
  const committed = await listGeneratedFiles(committedRoot);
  const regenerated = await listGeneratedFiles(regeneratedRoot);
  const committedPaths = committed.map((file) => file.path);
  const regeneratedPaths = regenerated.map((file) => file.path);
  if (JSON.stringify(committedPaths) !== JSON.stringify(regeneratedPaths)) {
    throw new ContractError(
      "GENERATED_PATH_SET_MISMATCH",
      "generated path sets differ",
      {
        committedOnly: committedPaths.filter((path) =>
          !regeneratedPaths.includes(path)
        ),
        regeneratedOnly: regeneratedPaths.filter((path) =>
          !committedPaths.includes(path)
        ),
      },
    );
  }
  const rawDiffs: string[] = [];
  for (let index = 0; index < committed.length; index++) {
    const left = committed[index];
    const right = regenerated[index];
    if (
      left.bytes.length !== right.bytes.length ||
      left.bytes.some((byte, byteIndex) => byte !== right.bytes[byteIndex])
    ) {
      rawDiffs.push(left.path);
      options.onRawDiff?.(left.path);
      if (left.path !== ORDERING_EXCEPTION) {
        throw new ContractError(
          "GENERATED_RAW_MISMATCH",
          `generated bytes differ outside the ordering exception: ${left.path}`,
          { path: left.path, rawDiffs },
        );
      }
      const leftCanonical = canonicalJsonBytes(
        parseJsonRejectDuplicateKeys(left.bytes),
      );
      const rightCanonical = canonicalJsonBytes(
        parseJsonRejectDuplicateKeys(right.bytes),
      );
      if (
        leftCanonical.length !== rightCanonical.length ||
        leftCanonical.some((byte, byteIndex) =>
          byte !== rightCanonical[byteIndex]
        )
      ) {
        throw new ContractError(
          "ORDERING_EXCEPTION_STRUCTURAL_MISMATCH",
          `${ORDERING_EXCEPTION} differs structurally`,
        );
      }
    }
  }
  const committedRegenerationHash = await hashGeneratedFiles(
    committed,
    "regeneration",
  );
  const regeneratedHash = await hashGeneratedFiles(regenerated, "regeneration");
  if (committedRegenerationHash !== regeneratedHash) {
    throw new ContractError(
      "REGENERATION_HASH_MISMATCH",
      "regeneration equivalence hashes differ",
      { committedRegenerationHash, regeneratedHash },
    );
  }
  return {
    fileCounts: {
      types: committed.filter((file) => file.path.startsWith("types/")).length,
      jsonSchema:
        committed.filter((file) => file.path.startsWith("json-schema/")).length,
    },
    rawDiffs,
    regenerationSha256: committedRegenerationHash,
  };
}

async function readStrictJson(path: string): Promise<unknown> {
  return parseJsonRejectDuplicateKeys(await Deno.readFile(path));
}

function assertGenerationMetadata(
  value: unknown,
): asserts value is GenerationMetadata {
  if (value === null || typeof value !== "object") {
    throw new ContractError(
      "GENERATION_METADATA_INVALID",
      "generation metadata is not an object",
    );
  }
  const metadata = value as Record<string, unknown>;
  const exactKeys = [
    "bundleSha256",
    "codexVersion",
    "codexVersionOutput",
    "commands",
    "experimental",
    "fileCounts",
    "generatedAt",
    "orderingException",
    "regenerationSha256",
    "schemaVersion",
  ];
  if (
    JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(exactKeys)
  ) {
    throw new ContractError(
      "GENERATION_METADATA_INVALID",
      "generation metadata has missing or unknown fields",
    );
  }
  const commands = metadata.commands as Record<string, unknown>;
  const counts = metadata.fileCounts as Record<string, unknown>;
  if (
    metadata.schemaVersion !== 1 || metadata.codexVersion !== "0.145.0" ||
    metadata.codexVersionOutput !== "codex-cli 0.145.0" ||
    metadata.experimental !== false ||
    JSON.stringify(commands?.types) !==
      JSON.stringify(["app-server", "generate-ts", "--out", "{output}"]) ||
    JSON.stringify(commands?.jsonSchema) !==
      JSON.stringify([
        "app-server",
        "generate-json-schema",
        "--out",
        "{output}",
      ]) ||
    typeof metadata.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.generatedAt)) ||
    !Number.isInteger(counts?.types) || (counts.types as number) < 1 ||
    !Number.isInteger(counts?.jsonSchema) ||
    (counts.jsonSchema as number) < 1 ||
    typeof metadata.bundleSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(metadata.bundleSha256) ||
    typeof metadata.regenerationSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(metadata.regenerationSha256) ||
    metadata.orderingException !== ORDERING_EXCEPTION
  ) {
    throw new ContractError(
      "GENERATION_METADATA_INVALID",
      "generation metadata violates the pinned stable contract",
    );
  }
}

export async function loadConfiguration(
  options: {
    repositoryRoot?: string;
    compatibilityPath?: string;
    coveragePath?: string;
  } = {},
): Promise<LoadedConfiguration> {
  const repositoryRoot = options.repositoryRoot
    ? await Deno.realPath(options.repositoryRoot)
    : await discoverRepositoryRoot();
  const compatibilityPath = options.compatibilityPath ??
    `${repositoryRoot}/spikes/codex-app-server/compatibility.json`;
  const coveragePath = options.coveragePath ??
    `${repositoryRoot}/spikes/codex-app-server/coverage.json`;
  const compatibilitySchema = await readStrictJson(
    `${repositoryRoot}/spikes/codex-app-server/schemas/compatibility.schema.json`,
  );
  const coverageSchema = await readStrictJson(
    `${repositoryRoot}/spikes/codex-app-server/schemas/coverage.schema.json`,
  );
  const compatibility = await readStrictJson(compatibilityPath);
  validateJsonAgainstSchema(
    compatibilitySchema,
    compatibility,
    "COMPATIBILITY_SCHEMA_INVALID",
  );
  const typedCompatibility = compatibility as CompatibilityManifest;
  const generatedRoot = await resolveRepositoryPath(
    repositoryRoot,
    typedCompatibility.generation.generatedRoot,
  );
  const generation = await readStrictJson(`${generatedRoot}/generation.json`);
  assertGenerationMetadata(generation);
  const coverage = await readStrictJson(coveragePath);
  validateJsonAgainstSchema(
    coverageSchema,
    coverage,
    "COVERAGE_SCHEMA_INVALID",
  );
  const typedCoverage = coverage as CoverageManifest;
  const rawHash = await hashGeneratedTree(generatedRoot, "raw");
  const regenerationHash = await hashGeneratedTree(
    generatedRoot,
    "regeneration",
  );
  const files = await listGeneratedFiles(generatedRoot);
  const observedCounts = {
    types: files.filter((file) => file.path.startsWith("types/")).length,
    jsonSchema:
      files.filter((file) => file.path.startsWith("json-schema/")).length,
  };
  if (
    rawHash !== typedCompatibility.generation.bundleSha256 ||
    rawHash !== generation.bundleSha256
  ) {
    throw new ContractError(
      "COMMITTED_BUNDLE_HASH_MISMATCH",
      "committed raw bundle hash differs",
      {
        manifest: typedCompatibility.generation.bundleSha256,
        metadata: generation.bundleSha256,
        observed: rawHash,
      },
    );
  }
  if (regenerationHash !== generation.regenerationSha256) {
    throw new ContractError(
      "COMMITTED_REGENERATION_HASH_MISMATCH",
      "committed regeneration hash differs from metadata",
      { metadata: generation.regenerationSha256, observed: regenerationHash },
    );
  }
  if (
    observedCounts.types !== generation.fileCounts.types ||
    observedCounts.jsonSchema !== generation.fileCounts.jsonSchema
  ) {
    throw new ContractError(
      "GENERATED_FILE_COUNT_MISMATCH",
      "generation metadata file counts differ from the committed tree",
      { metadata: generation.fileCounts, observed: observedCounts },
    );
  }
  if (typedCoverage.generatedBundleSha256 !== rawHash) {
    throw new ContractError(
      "COVERAGE_BUNDLE_HASH_MISMATCH",
      "coverage is not bound to the exact committed generated bytes",
    );
  }
  const { extractStableSurface, validateCoverageMembership } = await import(
    "./coverage.ts"
  );
  const stableSurface = await extractStableSurface(
    `${generatedRoot}/json-schema`,
  );
  validateCoverageMembership(typedCoverage, stableSurface);
  return {
    repositoryRoot,
    compatibilityPath,
    coveragePath,
    generatedRoot,
    compatibility: typedCompatibility,
    generation,
    coverage: typedCoverage,
    immutableInputsVerified: true,
    generatedArtifactsMatch: false,
  };
}
