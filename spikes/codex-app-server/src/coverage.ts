import {
  canonicalJsonBytes,
  ContractError,
  type CoverageEntry,
  type CoverageManifest,
  type ProtocolDirection,
} from "./config.ts";
import { extractMethodsFromUnionSchema } from "./protocol_validation.ts";
import type { RetainedProtocolRecord } from "./transcript.ts";

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

export function deriveCoverageFromJournal(
  baseline: CoverageManifest,
  surface: StableSurface,
  journal: readonly RetainedProtocolRecord[],
  supplied?: CoverageManifest,
): CoverageManifest {
  validateCoverageMembership(baseline, surface);
  const counts = new Map<string, number>();
  for (const record of journal) {
    if (record.schema.valid !== true) {
      throw new ContractError(
        "JOURNAL_SCHEMA_PROOF_MISSING",
        `journal record ${record.observationIndex} lacks schema proof`,
      );
    }
    let direction: ProtocolDirection | undefined;
    let method: string | undefined;
    if (record.direction === "client") {
      if (record.method === "<server-request-response>") {
        continue;
      }
      direction = record.id === undefined
        ? "client-notification"
        : "client-request";
      method = record.method;
    } else if (record.envelope?.kind === "server-notification") {
      direction = "server-notification";
      method = record.envelope.method;
    } else if (record.envelope?.kind === "server-request") {
      direction = "server-request";
      method = record.envelope.method;
    }
    if (direction === undefined || method === undefined) continue;
    const key = entryKey({ direction, method });
    if (!expectedCoverageKeys(surface).includes(key)) {
      throw new ContractError(
        "JOURNAL_METHOD_OUTSIDE_STABLE_SURFACE",
        `journal contains ${direction} ${method} outside generated membership`,
      );
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const entries = baseline.entries.map((entry): CoverageEntry => {
    const observedCount = counts.get(entryKey(entry)) ?? 0;
    if (observedCount === 0) {
      return { ...entry, observedCount: 0 };
    }
    if (entry.disposition === "unsupported") {
      throw new ContractError(
        "UNSUPPORTED_METHOD_OBSERVED",
        `unsupported ${entry.direction} ${entry.method} occurred`,
        { observedCount },
      );
    }
    if (entry.disposition === "intentionally-ignored") {
      return { ...entry, observedCount };
    }
    return {
      ...entry,
      disposition: "exercised",
      rationale:
        "Observed as a schema-valid record in the bidirectional protocol journal.",
      observedCount,
    };
  });
  const derived: CoverageManifest = { ...baseline, entries };
  validateCoverageMembership(derived, surface);

  if (supplied !== undefined) {
    validateCoverageMembership(supplied, surface);
    const facts = (coverage: CoverageManifest) =>
      coverage.entries.map((entry) => ({
        key: entryKey(entry),
        disposition: entry.disposition,
        observedCount: entry.observedCount,
      })).sort((left, right) => left.key.localeCompare(right.key));
    if (JSON.stringify(facts(supplied)) !== JSON.stringify(facts(derived))) {
      throw new ContractError(
        "COVERAGE_JOURNAL_DISAGREEMENT",
        "supplied coverage counts or dispositions disagree with the journal",
      );
    }
  }
  return derived;
}
