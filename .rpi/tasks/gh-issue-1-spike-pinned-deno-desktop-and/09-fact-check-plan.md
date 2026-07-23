---
task: gh-issue-1-spike-pinned-deno-desktop-and
type: fact-check
repo: vantage
branch: main
sha: d9909976312fffa50ea239a17e819104f4a7a18c
---

# Fact-check: Pinned Deno and Codex app-server compatibility spike plan

## Verdict

**Ready for implementation after in-place repairs.**

The fact-check found three errors and repaired all three in
`08-plan.md`. No scope, path, phase-correspondence, existing-suite, or
escaped-descendant-gate error remains. The plan still fails closed: Phases 5
and 6 cannot begin unless Phase 4 proves immediate escaped-descendant
containment with the real race-closing capability and fixture.

## Finding counts

| Category | High | Medium | Low | Total | Unverified |
| --- | ---: | ---: | ---: | ---: | ---: |
| Verification commands | 2 | 0 | 0 | 2 | 12 original distinct checklist command spellings were not fully exercisable as intended on the baseline |
| Semantic claims / internal consistency | 0 | 1 | 0 | 1 | 0 |
| Baseline gates | 0 | 0 | 0 | 0 | 4 gate groups |
| Test-suite expectations | 0 | 0 | 0 | 0 | 0 |
| Scope preservation | 0 | 0 | 0 | 0 | 0 |
| File paths | 0 | 0 | 0 | 0 | 0 |
| **Total** | **2** | **1** | **0** | **3** | — |

All three findings were repaired. There are no unrepaired errors and no
descoped outline items.

## Checks run

- Read the plan, structure outline, ticket, resolved research, revised design
  discussion, revised TDD, and red-team report in full.
- Gathered repository metadata: `mabrax/vantage`, branch `main`, commit
  `d9909976312fffa50ea239a17e819104f4a7a18c`.
- Inventoried the tracked repository outside `.git/` and `.rpi/`. It contains
  documentation and no `deno.json`, runtime source, generated protocol tree,
  fixture, test, evidence, or CI suite.
- Checked the current environment:
  - `deno`: unavailable on `PATH`;
  - `codex`: `/opt/homebrew/bin/codex`, reporting `codex-cli 0.145.0`;
  - Git: `2.50.1`;
  - host: Darwin arm64.
- Ran `codex app-server --help`,
  `codex app-server generate-ts --help`, and
  `codex app-server generate-json-schema --help`. The planned `--stdio`,
  stable `generate-ts --out`, and stable
  `generate-json-schema --out` forms are supported by the pinned CLI.
- Extracted and compared every planned phase, dependency, parallelism rule,
  ownership boundary, file path, test file, and verification command against
  `07-structure-outline.md`.
- Verified every cited architecture section and its claimed invariant against
  `docs/architecture/codex-app-server.md`,
  `docs/architecture/reliability.md`,
  `docs/architecture/README.md`, and
  `docs/architecture/vertical-slice.md`.
- Checked every path the plan treats as existing. The referenced architecture
  documents exist; all runtime paths are consistently introduced as new.
- Checked the six original direct `deno test` invocations against Deno's
  permission model. Deno tests inherit command-line permissions, and a
  `Deno.test` permission declaration may narrow but cannot grant permissions
  absent from the command. The planned suites require filesystem and/or
  subprocess access.
- Re-scanned all repaired sections and adjacent checklist material for
  contradictions. No direct permissionless `deno test` gate, live-platform
  exception, or proof-set responsibility assigned to `protocol:verify`
  remains.

## Findings and repairs

### FCP-001 — `protocol:verify` had contradictory responsibilities

**Severity:** High  
**Category:** Verification commands / internal normative consistency

**Quoted plan text before repair:**

> `deno task protocol:verify`

in Phase 1, followed in Phase 6 by:

> Re-running `deno task protocol:verify` after publication performs no writes
> and accepts only the current complete proof set.

**Evidence:**

- The normative TDD task contract defines `protocol:verify` as
  “generated hash + coverage completeness”
  (`05-tdd.md`, task contract around line 541).
- Phase 1 necessarily has no accepted transcript or summary.
- The TDD assigns staged proof-set publication and cross-hash revalidation to
  the acceptance publisher (`05-tdd.md`, “Evidence publication cannot leave a
  half-updated proof set”).

The original Phase 6 claim could not coexist with the Phase 1 command: the
same task would have to accept a valid pre-evidence baseline and also reject
every state without a complete accepted proof set.

**Repair applied:**

- Limited `protocol:verify` to read-only generated-bundle and coverage
  completeness checks.
- Kept complete staged and on-disk proof-set validation in `spike:accept` and
  its acceptance evaluator.
- Reworded the Phase 6 post-publication criterion accordingly.

### FCP-002 — platform validation excluded live verify-only runs

**Severity:** Medium  
**Category:** Semantic claims / internal consistency

**Quoted plan text before repair:**

> enforce the manifest platform only for live acceptance

**Evidence:**

- The plan's Validation Environment restricts both live compatibility and
  acceptance to manifest-selected `darwin`/`aarch64`.
- `spike:verify` is explicitly the real authenticated live runtime check.
- The authoritative structure outline says the selected `CODEX_HOME` and
  manifest platform are checked “for live tasks”
  (`07-structure-outline.md`, Validation Environment).

The old wording permitted `spike:verify` on an unsupported platform while
requiring the platform only for publication.

**Repair applied:**

- Required manifest-platform validation for both `spike:verify` and
  `spike:accept`.
- Preserved injected fake-platform probes for deterministic tests.

### FCP-003 — six direct test commands omitted required Deno permissions

**Severity:** High  
**Category:** Verification commands

**Quoted plan text before repair:**

> `deno test spikes/codex-app-server/tests/config_test.ts spikes/codex-app-server/tests/protocol_validation_test.ts spikes/codex-app-server/tests/coverage_test.ts`

> `deno test spikes/codex-app-server/tests/jsonl_client_test.ts`

> `deno test spikes/codex-app-server/tests/protocol_validation_test.ts`

> `deno test spikes/codex-app-server/tests/preflight_test.ts`

> `deno test spikes/codex-app-server/tests/transcript_test.ts`

> `deno test spikes/codex-app-server/tests/shutdown_test.ts`

**Evidence:**

- The plan requires these suites to read manifests/generated files, create
  temporary files or repositories, and launch Codex, Git, fake children,
  descendant fixtures, or platform probes.
- The plan separately requires permissions to be scoped by named repository
  tasks and forbids live-task permissions from leaking into deterministic
  tests.
- Deno's official testing and permission documentation states that tests use
  the runtime permission model and that permissions must be granted by the
  invoking command:
  <https://docs.deno.com/runtime/test/> and
  <https://docs.deno.com/runtime/reference/cli/test/>.

The original direct invocations granted none of the planned filesystem or
subprocess permissions, so the suites would fail or prompt rather than run as
deterministic gates.

**Repair applied:**

- Added required `deno.json` tasks:
  `test:contract`, `test:transport`, `test:lifecycle`, and `test:shutdown`.
- Required each task to run the exact phase-specific test files with only its
  scoped filesystem and subprocess permissions.
- Replaced the six direct checklist invocations with the four named task
  commands. This changes command spelling only; it preserves every test file
  and every outline verification intent.
- Kept `check` as the permission-scoped aggregate of all deterministic tasks
  without network or authentication.

## Checks with no findings

### Semantic claims and anchors

- `Codex process host`, `Wire protocol`, `Typed protocol client`, `Identity`,
  `Connection and thread lifecycle`, `Turn lifecycle`, and `Version and schema
  policy` exist at the claimed scopes in
  `docs/architecture/codex-app-server.md`.
- `Reliability invariants`, `Ordered ingestion and backpressure`, `Shutdown`,
  and `Safety and resource limits` exist and support the plan's cited
  invariants in `docs/architecture/reliability.md`.
- The “documentation-only/no executable Deno package” baseline is true at the
  reported commit.
- The plan's pinned Codex command forms and exact installed version are true
  in the current environment.

### Test-suite expectations

The repository has no existing executable test suite, scope tags, policy
checks, or CI convention that contradicts the proposed mechanism. Every test
file required by the outline remains in the repaired plan. The explicitly
authenticated test remains separated from deterministic `check`; live
behavior is gated through `spike:verify`.

### Scope preservation

All six outline phases, their dependency order, Phase 3/4 parallelism,
ownership boundaries, file lists, test files, and verification intent remain
present. The plan adds detail but sheds no outline item. Nothing was descoped.

### File paths

Every existing referenced document is present. Every runtime/configuration,
schema, generated, source, fixture, test, and evidence path is a planned-new
path, consistent with the repository baseline. No doubled cwd, `-C`/`--cwd`,
shell-prefix, quoting, or path-relativity error was found.

### Escaped-descendant containment

The fail-closed gate is preserved. Snapshot inspection can set at most
`noObservedDescendantsRemain`; it can never set
`escapedDescendantContainmentProven`. Phase 4 remains incomplete on tracker
unavailability, late arming, event loss/overflow, unlinked reparenting,
unterminated escaped processes, or an unverifiable signal target. Phases 5 and
6 remain dependency-blocked until the real immediate-`setsid`/reparent fixture
passes through the race-closing capability.

## Baseline and unverified items

The repaired plan now records these facts and fallbacks in its
`Fact-check baseline` section:

1. **Generation/protocol gates:** unverified because exact Deno `2.9.3`,
   `deno.json`, and the generated bundle do not yet exist. Static
   contract/path verification is the only fallback; Phase 1 cannot complete
   until its tasks run.
2. **Deterministic suites:** unverified because the runtime and all test files
   are planned-new. Each phase must run its new permission-scoped task before
   completion.
3. **Live verify/accept gates:** unverified because the authenticated
   `CODEX_HOME` was not inspected and Phase 4 containment is not yet proven.
   No manual or snapshot-only bypass is permitted.
4. **Clean-diff and proof-set gates:** unverified until generated and accepted
   artifacts exist. `protocol:verify` stays read-only; `spike:accept` owns
   proof-set publication and post-publication validation.

The race-closing Darwin containment/event-tracking facility remains a genuine
implementation evidence gap. The plan is ready to implement, but Phases 5 and
6 must remain blocked if Phase 4 cannot prove that capability.

## Artifacts

- Updated plan:
  `/Users/mabrax/Projects/vantage/.rpi/tasks/gh-issue-1-spike-pinned-deno-desktop-and/08-plan.md`
- Fact-check report:
  `/Users/mabrax/Projects/vantage/.rpi/tasks/gh-issue-1-spike-pinned-deno-desktop-and/09-fact-check-plan.md`
