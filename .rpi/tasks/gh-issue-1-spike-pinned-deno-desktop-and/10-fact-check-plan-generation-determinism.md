---
task: gh-issue-1-spike-pinned-deno-desktop-and
type: fact-check
repo: vantage
branch: rpi/gh-issue-1-spike-pinned-deno-desktop-and
sha: d9909976312fffa50ea239a17e819104f4a7a18c
---

# Fact-check: Phase 1 generation determinism correction

## Verdict

**The implementation plan is repaired and ready for a clean Phase 1 retry once exact Deno `2.9.3`
is explicitly selected again. Phase 1 remains incomplete.**

The generator evidence is mechanically reproduced. Codex CLI `0.145.0` does not provide
whole-tree raw-byte determinism: the only changing file is
`json-schema/codex_app_server_protocol.v2.schemas.json`, and the only changing JSON object order in
the preserved pair is `$.definitions`. The parsed values are equal after recursive object-key
sorting.

`08-plan.md` now separates exact committed-byte integrity from cross-generation semantic
equivalence. Generated files stay unmodified, while the regeneration exception applies to one
exact path and rejects duplicate keys or any key-set, array-order, or scalar-value change. The
blocked Run Ledger row remains unchanged as historical evidence.

No implementation file, workflow file, commit, branch, remote, or artifact outside the supplied
task directory was changed.

## Finding counts

| Category | High | Medium | Low | Total | Unverified |
| --- | ---: | ---: | ---: | ---: | ---: |
| Verification commands / gate contract | 1 | 0 | 0 | 1 | 9 planned Deno tasks |
| Semantic claims / internal consistency | 1 | 0 | 0 | 1 | 0 |
| Baseline gates | 0 | 1 | 0 | 1 | Phase 1 post-implementation suite |
| Test-suite expectations | 0 | 0 | 0 | 0 | 0 |
| Scope / upstream artifact alignment | 0 | 1 | 0 | 1 | 0 |
| File paths | 0 | 0 | 0 | 0 | 0 |
| **Total** | **2** | **2** | **0** | **4** | — |

The three plan-local errors were repaired. The remaining upstream-artifact mismatch is explicitly
recorded in the plan because this skill permits changes only to the plan and this report.

## Checks run

- Read the supplied plan, structure outline, ticket, resolved research, revised design discussion,
  revised TDD, red-team report, and prior fact-check report in full.
- Gathered repository metadata: `vantage`, branch
  `rpi/gh-issue-1-spike-pinned-deno-desktop-and`, commit
  `d9909976312fffa50ea239a17e819104f4a7a18c`.
- Confirmed the current environment:
  - `/opt/homebrew/bin/codex` reports `codex-cli 0.145.0`;
  - Darwin reports `arm64`;
  - Deno is absent from ordinary `PATH`;
  - the preserved temporary executable
    `/private/tmp/vantage-deno-2.9.3.gvhUMz/deno` reports exact Deno `2.9.3`.
- Inspected the preserved generator outputs and the blocked Run Ledger evidence.
- Independently ran three new clean stable TypeScript and JSON Schema generations with Codex CLI
  `0.145.0` in a temporary directory beneath the supplied task artifact directory, then removed
  that temporary directory.
- Every new run produced 617 TypeScript and 273 JSON Schema files. Their raw path-and-byte bundle
  hashes were:
  - `dca2370ae7096875d38ec34beadf6d0c26ef3f6dd9d3f5f659e3e64964833bc4`;
  - `9c90efa3905cf52c485f000a74a6c1804d0d833048b728fe2e83fe09e1d30fc0`;
  - `a2ede53f5292df732fbec6ffa706ed952bbf395632ed9c852e2c4bf25e206436`.
- `diff -qr` isolated both new pairwise differences to
  `json-schema/codex_app_server_protocol.v2.schemas.json`.
- Recursive `jq -S` canonicalization produced the same aggregate-schema hash for all three runs:
  `c63a5f56a03ec0b2946b1452678d67a620bacacaf120d4c9ad761fe42dfd144b`.
- A recursive structural comparison of the preserved `json-a` and `json-b` values found semantic
  equality and exactly one object whose insertion order differed: `$.definitions`.
- Re-scanned all repaired and adjacent Phase 1 sections for contradictions.
- Confirmed all six phases, dependencies, Phase 3/4 parallelism, ownership boundaries, and the
  fail-closed immediate-`setsid` containment gate remain present.
- Confirmed the Phase 1 checklist is still unchecked and the blocked Run Ledger row is unchanged.
- Confirmed no temporary fact-check generation directory remains in the task artifact directory.

## Findings and repairs

### FCP-GD-001 — whole-tree raw regeneration determinism is false

**Severity:** High  
**Category:** Semantic claims / internal consistency

**Quoted plan text before repair:**

> Stable TypeScript and draft-07 JSON Schema output from Codex CLI `0.145.0` is committed
> unmodified with exact generation metadata and a deterministic path-and-byte bundle hash.

and:

> Hash the combined bundle by sorting forward-slash relative paths and feeding each
> `path + NUL + bytes + NUL` record into SHA-256.

**Evidence:**

- The historical three runs have equal counts and distinct raw hashes.
- The independent three-run fact-check has equal counts and three new distinct raw hashes.
- In both evidence sets, `diff -qr` identifies only the aggregate v2 schema.
- The aggregate JSON values compare equal after recursive object-key sorting.
- The preserved pair differs in object-member order only at `$.definitions`.

A single raw hash cannot simultaneously identify one exact committed snapshot and serve as an
equality target for every clean regeneration.

**Repair applied:**

- `bundleSha256` now hashes the exact committed `types/` and `json-schema/` bytes and excludes
  `generation.json`. It is an immutable snapshot identity, not a cross-run claim.
- `regenerationSha256` uses the same path framing and raw bytes for every file except the exact
  aggregate-schema path.
- At that one path, the verifier rejects duplicate object keys, recursively sorts object keys,
  preserves array order and scalar values, and hashes a canonical structural encoding.
- `generation.json` records both hashes and the single named exception.
- Coverage and acceptance remain bound to the exact committed raw hash, and
  `generatedArtifactsMatch` also requires the read-only regeneration-equivalence gate.
- Canonicalized bytes are temporary comparison material only and are never written into the
  generated tree.

### FCP-GD-002 — the original Phase 1 mutation and reproducibility gates cannot pass

**Severity:** High  
**Category:** Verification commands / gate contract

**Quoted plan text before repair:**

> Regenerate into fresh temporary output and prove byte/hash/count reproducibility without touching
> the committed generated directory.

and:

> Mutating a temporary generated byte ... makes verification fail with a typed contract error.

**Evidence:**

Object-member reordering in the temporary aggregate schema changes bytes and the whole-tree raw hash
but is normal output from the pinned generator. The original command contract therefore rejects
semantically equal clean runs.

**Repair applied:**

- `protocol:verify` is defined as a no-write comparison of the committed snapshot and at least two
  independent fresh regenerations.
- It requires exact paths and counts, raw equality outside the one exception, semantic equality at
  the exception, matching `regenerationSha256`, and a current raw hash of the committed tree.
- It reports every raw differing path before applying the narrow exception.
- Tests now require:
  - temporary aggregate object-order-only variation to pass and be reported;
  - committed aggregate raw-byte changes, including reordering, to fail raw integrity;
  - every non-exempt byte change to fail;
  - duplicate keys or any aggregate key-set, array-order, or scalar-value change to fail;
  - changes to method membership, mode, versions, hashes, or exception path to fail.

The existing task spellings remain runnable plan targets. They cannot be executed yet because
`deno.json` and the planned implementation do not exist.

### FCP-GD-003 — the fact-check baseline treated a known-red gate as merely unverified

**Severity:** Medium  
**Category:** Baseline gates

**Quoted plan text before repair:**

> Deno is unavailable on `PATH`, so generation ... [is] unverified.

and:

> The exact generated file tree, actual file counts, and deterministic bundle hash are intentionally
> unknown until the pinned Codex CLI performs stable generation.

**Evidence:**

The preserved exact Deno executable and Run Ledger prove that generation was actually attempted.
The counts are repeatedly observed, and raw equality is known-red. Ordinary Deno tasks remain
unavailable on `PATH`, but static checking is not a valid fallback for the failed integrity gate.

**Repair applied:**

- Kept the ordinary `PATH` observation.
- Recorded the preserved exact Deno evidence, repeated counts, differing hashes, isolated file, and
  canonical equality.
- Marked the raw-equality gate known-red and Phase 1 incomplete.
- Required exact Deno reprovision/selection plus execution of the revised permission-scoped gates;
  static checking alone cannot complete Phase 1.
- Replaced the stale “counts unknown” evidence gap with the observed 617/273 values while retaining
  the rule that implementation derives rather than hard-codes them.

### FCP-GD-004 — the corrected contract diverges from supplied upstream artifacts

**Severity:** Medium  
**Category:** Scope / upstream artifact alignment

**Quoted plan text:**

> The TDD section **One compatibility manifest binds every executable check and retained
> artifact** is normative ...

**Evidence:**

- `07-structure-outline.md` still requires a fresh regeneration to match one deterministic raw
  bundle hash.
- `05-tdd.md` still defines regeneration through raw
  `path + NUL + file bytes + NUL` equality.
- `04-design-discussion.md` still calls unmodified generation reproducible under one deterministic
  bundle hash.
- `06-red-team-design.md` still records the raw path-and-byte strategy as passed.

Those statements cannot describe Codex CLI `0.145.0` after the mechanically verified aggregate
ordering behavior.

**Repair applied within allowed scope:**

- The plan explicitly names all four stale upstream artifacts and states that the Phase 1 two-hash
  integrity contract supersedes their raw-only regeneration wording for implementation.
- The plan preserves every phase, dependency, ownership boundary, file, and test intent.

**Remaining supervisor action:**

Align the structure outline, TDD, design discussion, and red-team disposition before a later
workflow treats them as independently normative. The fact-check skill does not permit editing
those supplied inputs.

## Prior fact-check findings carried forward

The prior report's three repairs remain valid:

1. `protocol:verify` remains read-only and limited to generated-artifact integrity plus coverage
   completeness; proof-set publication/revalidation remains owned by `spike:accept`.
2. Platform validation still applies to both live tasks, `spike:verify` and `spike:accept`.
3. Deterministic suites still run through permission-scoped `test:contract`, `test:transport`,
   `test:lifecycle`, and `test:shutdown` tasks rather than permissionless direct `deno test`
   commands.

No new contradiction was introduced in those sections.

## Preserved gates and scope

- All six phases remain present and unchecked.
- Phase 1 still has no implementation changes and remains incomplete.
- Phase 3 and Phase 4 remain parallel only after Phases 1 and 2 establish their shared contracts.
- Snapshot-only cleanup can set at most `noObservedDescendantsRemain`.
- `escapedDescendantContainmentProven` remains false unless the real race-closing capability tracks
  and terminates the immediate-`setsid`/reparent fixture.
- Phases 5 and 6 remain dependency-blocked until Phase 4 passes that fail-closed gate.
- The historical Phase 1 Run Ledger row is preserved verbatim.

## Unverified items and blockers

1. The nine planned Deno tasks cannot run until `deno.json` and their implementations exist.
2. A clean Phase 1 retry must explicitly select or reprovision exact Deno `2.9.3`; the preserved
   temporary executable is evidence, not a durable repository toolchain.
3. The repaired duplicate-key-rejecting comparator, raw snapshot hashing, two-hash metadata, and
   negative mutation tests remain unimplemented and therefore unverified.
4. The four upstream design artifacts retain stale raw-only wording. This is a supervisor alignment
   item, not permission to weaken or bypass the repaired Phase 1 gate.
5. The separate Phase 4 containment evidence gap remains unchanged and continues to block Phases 5
   and 6 if no race-closing macOS capability can be proven.

## Artifacts

- Updated plan:
  `/Users/mabrax/Projects/vantage/.rpi/tasks/gh-issue-1-spike-pinned-deno-desktop-and/08-plan.md`
- New fact-check report:
  `/Users/mabrax/Projects/vantage/.rpi/tasks/gh-issue-1-spike-pinned-deno-desktop-and/10-fact-check-plan-generation-determinism.md`

