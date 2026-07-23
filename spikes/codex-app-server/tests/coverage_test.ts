import {
  buildBaselineCoverage,
  expectedCoverageKeys,
  extractStableSurface,
  validateCoverageMembership,
} from "../src/coverage.ts";
import {
  canonicalJsonBytes,
  ContractError,
  type CoverageManifest,
  loadConfiguration,
} from "../src/config.ts";

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

function assertThrowsCode(operation: () => unknown, code: string): void {
  try {
    operation();
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

Deno.test("coverage equals the complete generated stable surface exactly once", async () => {
  const configuration = await loadConfiguration();
  const surface = await extractStableSurface(
    `${configuration.generatedRoot}/json-schema`,
  );
  validateCoverageMembership(configuration.coverage, surface, {
    requireZeroBaseline: true,
  });
  const expectedKeys = expectedCoverageKeys(surface);
  assertEquals(configuration.coverage.entries.length, expectedKeys.length);
  assertEquals(
    new Set(
      configuration.coverage.entries.map((entry) =>
        `${entry.direction}\u0000${entry.method}`
      ),
    ).size,
    configuration.coverage.entries.length,
  );
  assert(
    configuration.coverage.entries.every((entry) => entry.observedCount === 0),
  );
  assert(
    configuration.coverage.entries.every((entry) =>
      entry.disposition !== "exercised"
    ),
  );
  assert(
    configuration.coverage.entries
      .filter((entry) => entry.direction === "server-request")
      .every((entry) => entry.disposition === "unsupported"),
  );
});

Deno.test("baseline builder is canonical and bound to committed raw bytes", async () => {
  const configuration = await loadConfiguration();
  const surface = await extractStableSurface(
    `${configuration.generatedRoot}/json-schema`,
  );
  const rebuilt = buildBaselineCoverage(
    surface,
    configuration.compatibility.generation.bundleSha256,
  );
  assertEquals(
    new TextDecoder().decode(canonicalJsonBytes(rebuilt)),
    new TextDecoder().decode(canonicalJsonBytes(configuration.coverage)),
  );
  assertEquals(
    rebuilt.generatedBundleSha256,
    configuration.generation.bundleSha256,
  );
});

Deno.test("coverage rejects duplicate, omitted, extra, observed, and exercised baseline entries", async () => {
  const configuration = await loadConfiguration();
  const surface = await extractStableSurface(
    `${configuration.generatedRoot}/json-schema`,
  );
  const mutateAndReject = (
    mutate: (coverage: CoverageManifest) => void,
    code: string,
  ) => {
    const coverage = structuredClone(configuration.coverage);
    mutate(coverage);
    assertThrowsCode(
      () =>
        validateCoverageMembership(coverage, surface, {
          requireZeroBaseline: true,
        }),
      code,
    );
  };
  mutateAndReject(
    (coverage) => coverage.entries.push(structuredClone(coverage.entries[0])),
    "DUPLICATE_COVERAGE_ENTRY",
  );
  mutateAndReject(
    (coverage) => coverage.entries.pop(),
    "COVERAGE_MEMBERSHIP_MISMATCH",
  );
  mutateAndReject(
    (coverage) =>
      coverage.entries.push({
        direction: "client-request",
        method: "not/in/stable/schema",
        disposition: "schema-validated-unexercised",
        rationale: "Mutation fixture.",
        observedCount: 0,
      }),
    "COVERAGE_MEMBERSHIP_MISMATCH",
  );
  mutateAndReject(
    (coverage) => coverage.entries[0].observedCount = 1,
    "UNEXERCISED_WITH_OBSERVATION",
  );
  mutateAndReject(
    (coverage) => coverage.entries[0].disposition = "exercised",
    "EXERCISED_WITHOUT_EVIDENCE",
  );
});

Deno.test("coverage contract errors keep stable machine-readable codes", () => {
  const error = new ContractError("COVERAGE_TEST", "fixture");
  assertEquals(error.code, "COVERAGE_TEST");
});
