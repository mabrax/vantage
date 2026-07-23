---
task: gh-issue-1-spike-pinned-deno-desktop-and
type: fact-check
repo: vantage
branch: rpi/gh-issue-1-spike-pinned-deno-desktop-and
sha: 84ffc7499bf6c97fc70b7b48bd3de7d0c18899f1
---

# Fact-check: Observed-tree cleanup acceptance correction

## Verdict

**The implementation plan is repaired and Phase 4 is ready for a fresh implementation retry.**

The revised MVP acceptance contract now requires clean, deadline-bounded shutdown of the actual
pinned Codex CLI `0.145.0` app-server process tree observed during the live compatibility run. The
direct child must exit, stdout and stderr drains must settle, `remainingPids` must be empty, and
`noObservedDescendantsRemain` must be true.

Absolute containment of an arbitrary descendant that immediately calls `setsid()` is explicitly
unsupported. Its real fixture remains a cleanup-safe negative test that must retain
`DESCENDANT_LEAK`, tracker/containment diagnostics, and
`escapedDescendantContainmentProven: false`. That accurate false proof fact is not an MVP acceptance
blocker, and the plan never permits snapshot evidence to set it true.

Phases 1–3 remain complete. Phase 4 remains unchecked. Its historical blocked Run Ledger entry is
preserved verbatim. No implementation code, workflow, commit, branch, remote, or artifact outside
the supplied task directory was changed.

## Finding counts

| Category | Errors | Repaired | Unverified | Approved descoping |
| --- | ---: | ---: | ---: | ---: |
| Verification commands | 1 | 1 | 2 live tasks | 0 |
| Semantic claims / internal consistency | 3 | 3 | 0 | 0 |
| Baseline gates | 0 | 0 | 2 revised gate groups | 0 |
| Test-suite expectations | 1 | 1 | 0 | 0 |
| Scope preservation | 0 | 0 | 0 | 1 |
| File paths | 0 | 0 | 0 | 0 |
| **Total** | **5** | **5** | — | **1** |

There are no unrepaired plan errors. The one scope change is the user-approved replacement of
absolute arbitrary-descendant containment with observed cleanup of the actual pinned app-server
tree; the adversarial limitation remains implemented, diagnosed, and tested.

## Checks run

- Read the plan, ticket, resolved research, revised design discussion, revised TDD, red-team report,
  and both prior fact-check reports in full.
- Confirmed the report path did not exist and differed from every supplied input.
- Gathered repository metadata: `vantage`, branch
  `rpi/gh-issue-1-spike-pinned-deno-desktop-and`, commit
  `84ffc7499bf6c97fc70b7b48bd3de7d0c18899f1`.
- Verified the current environment:
  - Codex reports `codex-cli 0.145.0`;
  - Git reports `2.50.1`;
  - the host is Darwin arm64;
  - Deno is absent from ordinary `PATH`;
  - both preserved exact Deno executables report `2.9.3`.
- Inspected the current shutdown controller, Darwin process-tree boundary, evidence schema,
  transcript evidence tests, adversarial fixture, shutdown tests, and `deno.json` live-task
  permissions.
- Re-ran the current `deno task test:shutdown` with preserved exact Deno `2.9.3`: 12/12 tests
  passed. This is a baseline for the historical fail-closed implementation only; it does not prove
  the revised Phase 4 success semantics.
- Confirmed `src/main.ts`, `authenticated_turn_test.ts`, and both retained live-evidence files are
  planned-new Phase 5/6 paths rather than missing existing paths.
- Re-scanned all repaired and adjacent plan sections for stale requirements that both cleanup facts
  be true. No such requirement remains outside the preserved historical Phase 4 ledger entry.
- Ran `git diff --check`; the plan and report have no whitespace errors.

## Findings and repairs

### FCP-OC-001 — Phase 4 treated unavailable absolute containment as its completion gate

**Severity:** High  
**Category:** Semantic claims / internal consistency

**Quoted plan text before repair:**

> this phase cannot complete unless a race-closing tracker continuously covers descendant creation
> through final shutdown

and:

> unproven containment [is a] typed failure

**Repository evidence:**

- `spikes/codex-app-server/src/process_tree_darwin.ts:59-96` explicitly records that the current
  macOS/Deno boundary has only snapshot observation and no proof-producing tracker.
- `spikes/codex-app-server/src/process_tree_darwin.ts:279-294` calculates
  `noObservedDescendantsRemain` from the final observed PID set independently while keeping
  `escapedDescendantContainmentProven` false.
- `spikes/codex-app-server/src/shutdown.ts:339-420` currently records tracker/proof failures
  unconditionally and throws even after an otherwise clean observed shutdown. That behavior is the
  implementation target for the fresh retry, not evidence that the revised gate is impossible.

**Repair applied:**

- Renamed and rewrote Phase 4 around bounded observed-tree shutdown.
- Defined Phase 4 completion as settled direct status/drains, bounded escalation, safe identity,
  ordinary descendant cleanup, empty final observed PIDs, and
  `noObservedDescendantsRemain: true`.
- Made `TRACKER_UNAVAILABLE` and `CONTAINMENT_UNPROVEN` retained limitation diagnostics rather than
  selected fatal errors when observed cleanup succeeds.
- Kept timeout, unsafe identity, failed status/drains, and any remaining PID fatal.
- Added the focused evidence-schema and transcript-test amendments to Phase 4 ownership while
  preserving completed Phase 3 lifecycle/redaction/coverage behavior.

### FCP-OC-002 — Phase 5 still required escaped-descendant proof before or during the live run

**Severity:** High  
**Category:** Semantic claims / internal consistency

**Quoted plan text before repair:**

> it may not begin while escaped-descendant containment is unavailable or unproven

and:

> `noObservedDescendantsRemain`, and `escapedDescendantContainmentProven` all true

**Repository evidence:**

- The implemented shutdown evidence keeps the two facts independent.
- The supplied user decision makes the actual pinned Codex CLI `0.145.0` app-server run, not the
  arbitrary immediate-`setsid` fixture, the MVP cleanup subject.

**Repair applied:**

- Kept Phase 5 dependent on a freshly completed Phase 4 but removed absolute containment as a
  dependency.
- Required the actual pinned run to record direct exit, settled drains, empty `remainingPids`, and
  `noObservedDescendantsRemain: true`.
- Required `escapedDescendantContainmentProven` to remain present and accurate, but allowed false.
- Made an absent proof fact or a true value without separately validated race-closing evidence a
  failure; a correctly false fact alone is not a failure.

### FCP-OC-003 — Phase 6’s all-true acceptance set still included escaped containment

**Severity:** High  
**Category:** Semantic claims / internal consistency

**Quoted plan text before repair:**

> every true gate

and:

> both `noObservedDescendantsRemain` and `escapedDescendantContainmentProven` are true

**Repository evidence:**

- `spikes/codex-app-server/schemas/evidence.schema.json:560-612` currently represents both cleanup
  facts as independent booleans.
- `spikes/codex-app-server/tests/transcript_test.ts:536-551` already constructs a schema-valid
  summary with `noObservedDescendantsRemain: true` and
  `escapedDescendantContainmentProven: false`.

**Repair applied:**

- Defined the exact true acceptance-gate set:
  `exactVersions`, `generatedArtifactsMatch`, `coverageComplete`,
  `everyRetainedEnvelopeSchemaValid`, `lifecycleOrdered`, `authenticatedTurnCompleted`, and
  `noObservedDescendantsRemain`.
- Kept `escapedDescendantContainmentProven` as required structured shutdown evidence outside that
  all-true set.
- Required the accepted summary to retain direct exit, completed drains, bounded timings, empty
  `remainingPids`, containment capability, diagnostics, and both cleanup facts.
- Added rejection cases for a missing proof fact, remaining observed PID, and a true proof claim
  without validated race-closing evidence.
- Added a positive acceptance case for `noObservedDescendantsRemain: true` with
  `escapedDescendantContainmentProven: false`.

### FCP-OC-004 — live task permissions omitted required shutdown executables

**Severity:** High  
**Category:** Verification commands

**Quoted current command targets:**

> `deno task spike:verify`

> `deno task spike:accept`

**Repository evidence:**

- `deno.json:15-16` currently grants the live tasks only Codex and Git subprocess permissions.
- `spikes/codex-app-server/src/process_host.ts` launches `/usr/bin/python3` to establish the owned
  Unix session.
- `spikes/codex-app-server/src/process_tree_darwin.ts` uses `/bin/ps` for observations and
  `/bin/kill` for guarded process-group signals.

**Repair applied:**

- Added `deno.json` to Phase 5 ownership.
- Specified runnable live task definitions that add only `/usr/bin/python3`, `/bin/ps`, and
  `/bin/kill` to the existing scoped `--allow-run` lists.
- Preserved the existing read/write scopes and the distinction between verify-only and acceptance
  publication.

### FCP-OC-005 — the immediate-`setsid` suite expectation was a positive proof test

**Severity:** Medium  
**Category:** Test-suite expectations

**Quoted plan text before repair:**

> Require continuous lineage evidence, termination of the escaped PID ... before the proof flag may
> be true.

**Repository evidence:**

- `spikes/codex-app-server/tests/shutdown_test.ts:561-620` runs a real immediate-`setsid`/
  reparent fixture. It proves that the process escapes the owned group, remains in
  `remainingPids`, produces tracker diagnostics, keeps proof false, and is removed by the
  cleanup-safe harness.
- The current targeted suite passes 12/12, including this expected negative behavior.

**Repair applied:**

- Recast the fixture as a required negative limitation test.
- It must produce `DESCENDANT_LEAK` plus tracker/containment diagnostics, keep proof false, and
  leave no process behind after harness cleanup.
- A test pass records the unsupported limitation; it is never interpreted as containment proof and
  no longer blocks Phase 4 completion.

## Approved scope correction

The ticket, design discussion, TDD, red-team disposition, and historical Phase 4 ledger express
absolute descendant containment more strongly than the approved MVP criterion. The plan now
records this as an explicit user-approved descoping:

- supported acceptance: bounded clean shutdown of the actual pinned Codex CLI `0.145.0`
  app-server process tree observed during the real run;
- unsupported limitation: arbitrary descendants that immediately call `setsid()` and escape before
  observation;
- mandatory fail-closed behavior: leak/tracker diagnostics, cleanup-safe fixture removal, and no
  claim that escaped containment was proven.

The upstream artifacts were not edited. Their absolute-containment wording must not override the
repaired plan for this retry; they remain a later alignment item if another workflow treats them as
independently normative.

## Prior fact-check findings carried forward

The prior reports’ still-valid repairs remain in force:

1. `protocol:verify` remains read-only and limited to generated-artifact integrity plus coverage
   completeness; proof-set publication and complete on-disk validation remain owned by
   `spike:accept`.
2. Manifest-platform validation still applies to both live tasks.
3. Deterministic suites still use permission-scoped named tasks.
4. Generated artifacts still use separate raw committed-byte identity and narrowly scoped
   regeneration equivalence for the aggregate-schema object-order exception.
5. Phase 1’s historical blocked generation row and its later successful row remain unchanged.

## Unverified items and blockers

1. **Phase 4 implementation retry required.** The current controller still throws
   `TRACKER_UNAVAILABLE` / `CONTAINMENT_UNPROVEN` after clean observed shutdown. The plan is
   retry-ready, but code and tests must be changed and the revised `deno task test:shutdown` gate
   rerun before Phase 4 can be checked complete.
2. **Current 12/12 is historical-semantics evidence only.** It verifies the existing fail-closed
   implementation and cleanup-safe adversarial fixture, not the revised ordinary-shutdown success
   path.
3. **Live phases remain unimplemented.** `src/main.ts`, `authenticated_turn_test.ts`, and the two
   retained live-evidence files do not yet exist, so `spike:verify` and `spike:accept` cannot be run.
4. **Authenticated live environment required later.** Phase 5 needs a caller-selected,
   already-authenticated `CODEX_HOME`; none was inspected or used during this fact-check.
5. **Exact Deno selection is still needed.** Deno `2.9.3` is absent from ordinary `PATH`, although
   preserved exact executables exist and one was used for the non-mutating shutdown baseline.

Items 1–2 are the work of the fresh Phase 4 retry, not plan blockers. Items 3–5 block later
execution, not Phase 4 planning. No unrepaired blocker prevents the Phase 4 retry.

## Artifacts

- Updated plan:
  `/Users/mabrax/Projects/vantage/.rpi/tasks/gh-issue-1-spike-pinned-deno-desktop-and/08-plan.md`
- New fact-check report:
  `/Users/mabrax/Projects/vantage/.rpi/tasks/gh-issue-1-spike-pinned-deno-desktop-and/11-fact-check-plan-observed-cleanup.md`
