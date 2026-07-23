import {
  canonicalJsonBytes,
  ContractError,
  type CoverageEntry,
  type CoverageManifest,
  type ProtocolDirection,
} from "./config.ts";
import { extractMethodsFromUnionSchema } from "./protocol_validation.ts";

const DIRECTION_ORDER: ProtocolDirection[] = [
  "client-request",
  "client-notification",
  "server-notification",
  "server-request",
];

const DIRECTION_SCHEMA: Record<ProtocolDirection, string> = {
  "client-request": "ClientRequest.json",
  "client-notification": "ClientNotification.json",
  "server-notification": "ServerNotification.json",
  "server-request": "ServerRequest.json",
};

export type StableSurface = ReadonlyMap<ProtocolDirection, ReadonlySet<string>>;

export async function extractStableSurface(
  schemaRoot: string,
): Promise<StableSurface> {
  const result = new Map<ProtocolDirection, ReadonlySet<string>>();
  for (const direction of DIRECTION_ORDER) {
    const schema = JSON.parse(
      await Deno.readTextFile(`${schemaRoot}/${DIRECTION_SCHEMA[direction]}`),
    );
    const methods = extractMethodsFromUnionSchema(schema);
    if (methods.size === 0) {
      throw new ContractError(
        "EMPTY_GENERATED_DIRECTION",
        `generated ${direction} union has no methods`,
      );
    }
    result.set(direction, methods);
  }
  return result;
}

function entryKey(entry: Pick<CoverageEntry, "direction" | "method">): string {
  return `${entry.direction}\u0000${entry.method}`;
}

export function expectedCoverageKeys(surface: StableSurface): string[] {
  const keys: string[] = [];
  for (const direction of DIRECTION_ORDER) {
    for (const method of [...(surface.get(direction) ?? [])].sort()) {
      keys.push(entryKey({ direction, method }));
    }
  }
  return keys;
}

export function validateCoverageMembership(
  coverage: CoverageManifest,
  surface: StableSurface,
  options: { requireZeroBaseline?: boolean } = {},
): void {
  const seen = new Set<string>();
  for (const entry of coverage.entries) {
    const key = entryKey(entry);
    if (seen.has(key)) {
      throw new ContractError(
        "DUPLICATE_COVERAGE_ENTRY",
        `coverage repeats ${entry.direction} ${entry.method}`,
      );
    }
    seen.add(key);
    if (!entry.rationale.trim()) {
      throw new ContractError(
        "EMPTY_COVERAGE_RATIONALE",
        `coverage rationale is empty for ${entry.direction} ${entry.method}`,
      );
    }
    if (!Number.isInteger(entry.observedCount) || entry.observedCount < 0) {
      throw new ContractError(
        "INVALID_OBSERVATION_COUNT",
        `coverage count is invalid for ${entry.direction} ${entry.method}`,
      );
    }
    if (entry.disposition === "exercised" && entry.observedCount === 0) {
      throw new ContractError(
        "EXERCISED_WITHOUT_EVIDENCE",
        `coverage marks unobserved method exercised: ${entry.direction} ${entry.method}`,
      );
    }
    if (
      entry.disposition === "schema-validated-unexercised" &&
      entry.observedCount !== 0
    ) {
      throw new ContractError(
        "UNEXERCISED_WITH_OBSERVATION",
        `coverage marks observed method unexercised: ${entry.direction} ${entry.method}`,
      );
    }
    if (options.requireZeroBaseline && entry.observedCount !== 0) {
      throw new ContractError(
        "NONZERO_BASELINE_COVERAGE",
        `Phase 1 baseline has evidence for ${entry.direction} ${entry.method}`,
      );
    }
  }
  const expected = expectedCoverageKeys(surface);
  const actual = [...seen].sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new ContractError(
      "COVERAGE_MEMBERSHIP_MISMATCH",
      "coverage does not equal the complete generated stable surface",
      {
        omitted: sortedExpected.filter((key) => !seen.has(key)),
        extra: actual.filter((key) => !sortedExpected.includes(key)),
      },
    );
  }
}

export function buildBaselineCoverage(
  surface: StableSurface,
  bundleSha256: string,
): CoverageManifest {
  const entries: CoverageEntry[] = [];
  for (const direction of DIRECTION_ORDER) {
    for (const method of [...(surface.get(direction) ?? [])].sort()) {
      const unsupported = direction === "server-request";
      entries.push({
        direction,
        method,
        disposition: unsupported
          ? "unsupported"
          : "schema-validated-unexercised",
        rationale: unsupported
          ? "The compatibility spike has no safe stable response policy for this server request."
          : "Present in the pinned stable schema but not observed in the Phase 1 baseline.",
        observedCount: 0,
      });
    }
  }
  return {
    schemaVersion: 1,
    codexVersion: "0.145.0",
    generatorMode: "stable",
    generatedBundleSha256: bundleSha256,
    entries,
  };
}

export function serializeCoverage(coverage: CoverageManifest): Uint8Array {
  return canonicalJsonBytes(coverage);
}
