---
task: gh-issue-1-spike-pinned-deno-desktop-and
type: plan
repo: vantage
branch: main
sha: d9909976312fffa50ea239a17e819104f4a7a18c
---

# Pinned Deno and Codex app-server compatibility spike implementation plan

## Overview

Build the repository's first executable compatibility proof around the exact Deno `2.9.3` and
Codex CLI `0.145.0` pair. The work starts by making the generated stable protocol contract
reproducible, proves JSONL transport and lifecycle policy with deterministic child processes, then
integrates one authenticated turn and publishes a cross-hashed proof set.

The MVP compatibility claim is deliberately scoped to the actual pinned Codex CLI `0.145.0`
app-server process tree observed during the real compatibility run. Acceptance requires bounded
shutdown with the direct child exited, stdout/stderr drains settled, every observed descendant and
owned process-group member absent, and `noObservedDescendantsRemain: true`. Process-group signaling
and post-shutdown snapshots must never be presented as proof that an arbitrary descendant which
immediately calls `setsid()` was contained. The adversarial fixture remains an explicit
unsupported, fail-closed limitation: it must retain leak/tracker diagnostics and
`escapedDescendantContainmentProven: false`, but that false proof flag no longer blocks Phase 4,
Phase 5, Phase 6, or MVP acceptance when the actual pinned Codex run satisfies the observed-tree
shutdown gate.

## Current State Analysis

Vantage currently contains architecture documentation and no executable Deno package, source
module, generated protocol bundle, fixture, test, or retained compatibility evidence. Every
runtime file in this plan is therefore new; there are no existing implementation symbols to
transcribe.

### Key Discoveries

- Bind child ownership to `docs/architecture/codex-app-server.md` section **Codex process host**:
  resolve and launch an executable without a shell, keep stdio streams independent, expose direct
  status, terminate descendants, and make close idempotent.
- Bind transport behavior to `docs/architecture/codex-app-server.md` sections **Wire protocol** and
  **Typed protocol client**: one newline-terminated JSON object per message, serialized stdin,
  bounded stdout framing, request-ID correlation, ordered server messages, and stderr excluded
  from protocol parsing.
- Bind ordering and resource policy to `docs/architecture/reliability.md` sections **Reliability
  invariants**, **Ordered ingestion and backpressure**, and **Safety and resource limits**. A
  bounded reader may fail but may not silently drop, duplicate, or reorder a complete frame.
- Bind shutdown to `docs/architecture/reliability.md` section **Shutdown**, including one bounded
  path for success and failure exits. Its invariant that shutdown leaves no app-server
  descendants is stronger than direct-child exit or an empty process-table snapshot.
- Bind generated artifacts and coverage to
  `docs/architecture/codex-app-server.md` section **Version and schema policy**. Generated
  TypeScript, generated JSON Schema, and complete stable-surface classification all come from the
  exact pinned CLI in stable mode.
- The TDD section **One compatibility manifest binds every executable check and retained
  artifact** is normative for manifest field names and literal pins. The TDD sections **The
  coverage manifest is complete over the generated stable surface**, **Transcript validation
  proves transport order and semantic lifecycle separately**, and **The summary
  cryptographically binds versions, protocol evidence, and observations** are normative for
  coverage, retained-record, and summary contracts except for the cleanup acceptance criterion
  superseded by the user-approved MVP decision in this plan: `noObservedDescendantsRemain` is the
  required true acceptance gate, while `escapedDescendantContainmentProven` remains a separately
  required evidence fact that may be false and may never be set true without race-closing proof.
- The red-team revision requires immutable compatibility inputs, bidirectional journal-derived
  coverage, draft-07 validation with explicit Codex numeric formats, register-before-write
  correlation, complete-frame indexing before validation, bounded model pagination, and a
  distinct escaped-descendant proof gate.

## Desired End State

- `deno.json` exposes repository-owned deterministic, generation, verification, live-verification,
  and acceptance tasks, while the immutable manifest pins Deno `2.9.3`, Codex CLI `0.145.0`,
  stable generation, macOS arm64 validation, and named safety bounds.
- Stable TypeScript and draft-07 JSON Schema output from Codex CLI `0.145.0` is committed
  unmodified. A raw path-and-byte hash identifies the exact committed snapshot, while a separate
  deterministic regeneration-equivalence hash tolerates object-member ordering only in the known
  aggregate schema and remains sensitive to every structural or scalar JSON change.
- A complete coverage manifest classifies every method in the generated stable client-request,
  client-notification, server-notification, and server-request unions exactly once.
- A Deno process host and JSONL client prove real-pipe framing, independent stderr drainage,
  register-before-write response correlation, complete-frame observation order, schema dispatch,
  queue limits, EOF behavior, and typed diagnostics.
- Offline fake-child scenarios prove version/authentication preflight, bounded model pagination,
  native thread/turn/item continuity, raw-before-redaction validation, schema-preserving retained
  evidence, journal-derived coverage, and every shutdown entry path.
- macOS arm64 shutdown separately records `noObservedDescendantsRemain` and
  `escapedDescendantContainmentProven`. The actual pinned Codex run must make the first true after
  bounded shutdown; the second remains false unless continuously covered lineage tracking really
  contains an immediate session-escaping descendant.
- One explicit authenticated run completes the required initialize, catalog, thread, turn,
  streaming, and terminal lifecycle in a disposable Git repository without changing committed
  evidence.
- Acceptance stages and validates run-derived coverage, a redacted bidirectional journal, and a
  summary as one cross-hashed proof set. Any stale, partial, mismatched, or false
  acceptance-required gate derives candidate status; an accurately false
  `escapedDescendantContainmentProven` limitation does not.

## Validation Environment

- **Target**: Repository-owned Deno `2.9.3` tasks. Deterministic phases use real subprocess pipes
  and fake app-server children without credentials or network access. Live compatibility and
  acceptance run Codex CLI `0.145.0` on the manifest-selected `darwin`/`aarch64` target with an
  already-authenticated caller-selected `CODEX_HOME`.
- **Preflight checks**: Confirm the intended repository revision; run `deno --version`,
  `codex --version`, and `git --version`; require the exact manifest-selected Deno and Codex
  versions; run `deno task protocol:verify`; and, before live work, verify the selected account is
  non-null and Phase 4's revised observed-tree shutdown boundary has passed.
- **Migration/setup policy**: No database, service, authentication, or account migration is
  permitted. `deno task protocol:generate` may regenerate only through the exact pinned Codex CLI
  in stable mode, into temporary output before deterministic compare or replacement. Tests may
  create disposable Git repositories, child processes, and temporary evidence directories, but
  may not create, copy, or modify credentials.
- **Blocked means**: Deterministic validation is blocked by an unavailable exact Deno toolchain; a
  generated path/count mismatch; a raw-byte mismatch outside the one named aggregate-schema
  exception; duplicate JSON object keys; or structural, array-order, or scalar inequality in that
  exception after recursive object-key sorting. Raw hash inequality between independent full-tree
  generations is not itself a blocker because Codex CLI `0.145.0` emits nondeterministic object
  order in `json-schema/codex_app_server_protocol.v2.schemas.json`. Live compatibility is blocked
  by missing or mismatched Codex, `account: null`, the wrong platform, a live protocol failure,
  stale hashes, unsafe or incomplete shutdown evidence, or any direct child, observed descendant,
  or owned process-group member remaining after the actual pinned run. Tracker unavailability and
  `escapedDescendantContainmentProven: false` remain recorded limitations but are not MVP blockers
  when the pinned run has `noObservedDescendantsRemain: true`.

### Fact-check baseline

- At fact-check time on `main` at `d9909976312fffa50ea239a17e819104f4a7a18c`, the tracked
  repository has no `deno.json`, source module, generated bundle, fixture, test, or retained
  evidence. Every Deno task and test gate below is therefore a post-implementation command rather
  than an existing green baseline.
- Deno is unavailable on ordinary `PATH`, so the planned Deno tasks, deterministic suites, live
  verification, acceptance, and post-generation clean-diff gate remain unverified and may not be
  marked complete. A preserved temporary executable does report exact Deno `2.9.3`, and the prior
  generation gate is known-red under whole-tree raw equality rather than merely unverified. Phase 1
  must reprovision or explicitly select exact Deno `2.9.3`, implement the revised dual integrity
  contract below, and run every permission-scoped gate; static checking alone cannot complete it.
- The available preflight evidence is `codex-cli 0.145.0`, Git `2.50.1`, and Darwin arm64. Live
  tasks remain separately blocked until the caller supplies an already-authenticated selected
  `CODEX_HOME` and the revised Phase 4 observed-tree shutdown gate passes.
- A blocked Phase 1 attempt provisioned exact temporary Deno `2.9.3` and generated three clean
  stable outputs with Codex CLI `0.145.0`. Each contained 617 TypeScript and 273 JSON Schema files.
  Whole-tree raw hashes differed, `diff -qr` isolated every byte difference to
  `json-schema/codex_app_server_protocol.v2.schemas.json`, and recursively key-sorted JSON values
  compared equal. A fresh fact-check rerun independently reproduced the same counts, the same
  single differing path, three distinct raw bundle hashes, and one equal canonical aggregate hash.
  Phase 1 remains incomplete, but this evidence narrows the reproducibility exception to object
  ordering at one exact path.

## UX Readiness

**Level**: foundation-only

This work provides runtime evidence and actionable command-line diagnostics. It creates no window,
route, WebView, browser flow, visual component, or product conversation copy. Visual product
review is not part of any phase gate.

## What We're NOT Doing

- No Deno Desktop window, WebView, desktop gateway, SSE transport, SQLite persistence, or product
  conversation UI.
- No durable Vantage project/thread model, thread resume, native reconciliation, approval UX,
  interruption UX, or general provider-to-UI projection.
- No Codex version range, experimental generator mode, or experimental app-server capability.
- No Windows, Linux, or macOS x86_64 compatibility or descendant-cleanup claim.
- No requirement that an optional notification occur merely because a previous live run observed
  it.
- No retention of raw prompt/response text, credentials, authentication material, direct personal
  identifiers, home paths, repository paths, or unbounded stderr.
- No generic provider abstraction around this Codex-specific spike.
- No implementation-phase commits, pull request operations, issue updates, or branch cleanup are
  included in this plan.

## Implementation Approach

Build the proof in dependency order, using deterministic integration tests before credentials:

1. Establish immutable pins, generated inputs, draft-07 validation, and complete stable-surface
   classification.
2. Prove the child-process and JSONL transport boundary over actual pipes.
3. Build lifecycle/evidence policy and bounded shutdown in parallel only after the shared
   transport interfaces are fixed; the two phases have disjoint ownership.
4. Compose a verify-only authenticated run after Phase 4 proves bounded observed-tree cleanup and
   preserves the adversarial escape as an explicit unsupported limitation.
5. Publish the run-derived proof set through the explicit acceptance path and re-derive candidate
   versus validated status from disk.

Existing architecture section names above are the binding invariants for new code. New public data
contracts must match the normative TDD contracts; private identifiers and helper signatures are
implementation details and are not invented in this plan. Numeric resource values must come from
the compatibility manifest and must not be introduced ad hoc in implementation or tests.

## Phase Checklist

- [x] Phase 1: Establish the immutable compatibility and generated-protocol contract
- [x] Phase 2: Prove bounded bidirectional JSONL transport over a real child process
- [x] Phase 3: Prove preflight, lifecycle, transcript, and coverage behavior offline
- [x] Phase 4: Prove bounded observed-tree shutdown and preserve escaped-descendant diagnostics
- [x] Phase 5: Complete the authenticated compatibility run in verify-only mode
- [x] Phase 6: Publish and re-verify one atomic acceptance proof set

---

## Phase 1: Establish the immutable compatibility and generated-protocol contract

### Overview

Create the Deno package foundation, immutable compatibility record, exact-version generator,
generated stable protocol trees, local schemas, complete baseline coverage, and offline validation
tests. This phase proves reproducible inputs only; it does not launch app-server or declare the
pair compatible.

### Dependencies and Parallelism

- **Depends on**: None
- **Can run in parallel with**: None
- **Parallel ownership boundary**: Not applicable. This phase owns task names, dependency pins,
  manifest/schema shapes, generated paths, hashing, coverage membership, and the protocol
  validation boundary consumed by all later phases.
- **Execution note**: Concurrent phase runs require isolated worktrees and a parent-owned
  integration strategy.

### Changes Required

#### 1.1 Repository tasks and dependency pins

**File**: `deno.json`

**Changes**:

- Pin non-generated imports, including the Ajv draft-07 boundary. Application modules must import
  schema validation through `src/protocol_validation.ts`, not select a different Ajv draft.
- Add `check`, `test:contract`, `test:transport`, `test:lifecycle`, `test:shutdown`,
  `protocol:generate`, `protocol:verify`, `spike:verify`, and `spike:accept` tasks. The four
  `test:*` tasks run the exact phase-specific test files named below with their required scoped
  filesystem and subprocess permissions; they replace the outline's permissionless direct
  `deno test` spellings without changing test coverage. `check` runs formatting check, lint, type
  checking, and all deterministic test tasks without network or authentication.
  `protocol:verify` performs no writes and is limited to generated-bundle and coverage
  completeness checks. `spike:verify` must not change committed evidence. Only `spike:accept` may
  publish and post-publication-validate the complete proof set.
- Scope task permissions to the manifest, generated bundle, temporary directories, resolved
  `codex` and `git` executables, selected `CODEX_HOME`, and macOS process inspection/signaling
  needed by the named task. Do not grant live-task permissions to deterministic tests.

#### 1.2 Immutable compatibility and local schema contracts

**Files**:

- `spikes/codex-app-server/compatibility.json`
- `spikes/codex-app-server/schemas/compatibility.schema.json`
- `spikes/codex-app-server/schemas/coverage.schema.json`

**Changes**:

- Implement the manifest fields from the TDD's normative `CompatibilityManifest`: literal Deno
  and Codex pins, exact version output, app-server argument array, stable generator commands,
  generated root/hash, `darwin`/`aarch64` validation policy, cleanup strategy, and named transport,
  pagination, lifecycle, and shutdown bounds.
- Keep validation status and any run-specific coverage hash out of the immutable manifest.
  Candidate/validated status is derived later from a matching proof set.
- Reject unknown manifest fields, wrong literal pins, non-positive limits, absolute or
  repository-escaping generated paths, unsupported platforms, unstable generator commands, and
  generator arguments that enable experimental output.
- Implement the TDD's normative coverage fields and dispositions. Enforce a non-empty rationale,
  non-negative observation counts, stable bundle binding, supported directions, and uniqueness by
  direction plus method.

#### 1.3 Reproducible generated protocol bundle

**Files**:

- `spikes/codex-app-server/src/generate_protocol.ts`
- `spikes/codex-app-server/generated/0.145.0/generation.json`
- `spikes/codex-app-server/generated/0.145.0/types/**`
- `spikes/codex-app-server/generated/0.145.0/json-schema/**`

**Changes**:

- Resolve and run Codex without a shell; require exact output `codex-cli 0.145.0` before invoking
  either stable generator command.
- Generate TypeScript and JSON Schema trees beneath one temporary sibling, with experimental mode
  false. Do not edit, format, or normalize generated file bytes.
- Calculate `bundleSha256` over the exact committed `types/` and `json-schema/` tree bytes,
  excluding `generation.json`, by sorting forward-slash relative paths and feeding each
  `path + NUL + bytes + NUL` record into SHA-256. This raw hash identifies and protects the
  committed snapshot; it is not a cross-run reproducibility assertion.
- Calculate `regenerationSha256` with the same path framing and raw bytes for every file except
  `json-schema/codex_app_server_protocol.v2.schemas.json`. For that exact file only, reject
  duplicate object keys, parse JSON, recursively sort object keys, preserve array order and scalar
  values, and hash the resulting canonical structural encoding. No other path or transformation is
  permitted.
- Record the exact commands, `experimental: false`, generation time, actual per-tree file counts,
  Codex version, raw `bundleSha256`, deterministic `regenerationSha256`, and the single named
  ordering exception in `generation.json`. Counts are observed metadata, not hard-coded generator
  acceptance values.
- In verify mode, compare only the generated `types/` and `json-schema/` trees and require exact
  path-set and file-count equality; raw-byte equality for every file outside the named exception;
  duplicate-key-free, recursively key-sorted structural equality for the named aggregate schema;
  equality with the recorded `regenerationSha256`; and equality between the recorded raw
  `bundleSha256` and a fresh hash of the committed tree. Emit the raw file-level diff before
  applying the narrow semantic comparison so reviewers can see every tolerated byte difference.
- In generate mode, replace the versioned generated directory only after both trees and metadata
  validate. Select one clean generator output as the committed snapshot and preserve every
  generated byte exactly; never write a canonicalized or otherwise normalized file into the
  generated tree.

#### 1.4 Configuration loading and deterministic hashing

**File**: `spikes/codex-app-server/src/config.ts`

**Changes**:

- Load and validate the compatibility record, generation metadata, and coverage manifest before
  exposing configuration to later modules.
- Resolve repository-relative paths against a discovered repository root, normalize separators for
  hash input, reject path traversal or symlink escape, and keep runtime filesystem paths separate
  from canonical hash paths.
- Provide raw file/tree hashing for committed generated-artifact identity, the narrowly scoped
  duplicate-key-rejecting regeneration comparator from section 1.3, and deterministic canonical
  JSON hashing for repository-owned proof-set serialization. Keep those three purposes separate;
  the aggregate-schema ordering exception must not weaken committed-byte integrity or later
  proof-set validation.
- Bind coverage and acceptance summaries to the exact committed raw `bundleSha256`. Treat
  `generatedArtifactsMatch` as true only when that committed-byte check passes and the latest
  read-only regeneration verification has also established `regenerationSha256` equivalence under
  the single named exception.
- Expose immutable-input verification separately from derived proof-set status so no caller can
  treat a valid manifest alone as a validated pair.

#### 1.5 Draft-07 protocol validation

**File**: `spikes/codex-app-server/src/protocol_validation.ts`

**Changes**:

- Compile every generated top-level schema once with Ajv's draft-07 class.
- Register range-checking validators for the generated Codex formats `uint`, `uint16`, `uint32`,
  and `int64` before compilation. Keep any other unknown format fatal.
- Build method-specific validation dispatch from generated stable request, response,
  notification, and server-request unions. Do not hand-maintain method lists.
- Validate full invoked parameter/result payloads and full retained envelopes. A method with no
  matching pinned schema is unknown, not implicitly compatible.

#### 1.6 Complete stable-surface coverage

**Files**:

- `spikes/codex-app-server/src/coverage.ts`
- `spikes/codex-app-server/coverage.json`

**Changes**:

- Extract generated membership for all four protocol directions named by the TDD. Require coverage
  set equality, with no duplicate, omitted, extra, or experimental method.
- Create the initial canonical baseline with zero observations. Classifications must distinguish
  exercised, schema-validated-unexercised, intentionally ignored, and unsupported behavior, with
  rationales consistent with the spike's lifecycle.
- Treat `exercised` as journal evidence, never merely the presence of a schema or a passing unit
  test. Phase 1 therefore cannot mark entries exercised.

#### 1.7 Deterministic contract tests

**Files**:

- `spikes/codex-app-server/tests/config_test.ts`
- `spikes/codex-app-server/tests/protocol_validation_test.ts`
- `spikes/codex-app-server/tests/coverage_test.ts`

**Changes**:

- Cover schema rejection, exact literals, repository-relative path normalization, path escape,
  immutable hash binding, generation metadata disagreement, and generated-bundle mismatch.
- Compile all generated top-level schemas and exercise valid/invalid boundaries for every named
  Codex numeric format plus fatal unknown-format behavior.
- Prove generated and coverage memberships are equal sets, all entries are unique, experimental
  methods are absent, and baseline observation counts remain zero.
- Compare the committed snapshot with at least two independent fresh temporary regenerations.
  Prove identical paths and counts, raw equality outside the named aggregate schema, and equal
  `regenerationSha256` values without touching the committed generated directory. Prove that
  aggregate object-order-only variation passes, while duplicate keys or any key-set, array-order,
  or scalar-value change fails.

### Success Criteria

#### Automated Verification

- [ ] `deno task protocol:generate`
- [ ] `deno task protocol:verify`
- [ ] `deno task test:contract`
- [ ] `deno task check`
- [ ] The committed tree and at least two fresh temporary regenerations have identical path sets and
  file counts, raw-identical files outside
  `json-schema/codex_app_server_protocol.v2.schemas.json`, and one matching deterministic
  `regenerationSha256`, while
  `git diff --exit-code -- spikes/codex-app-server/generated/0.145.0` remains clean.
- [ ] The committed raw `bundleSha256` exactly matches the committed generated bytes. Changing any
  committed generated byte, changing any non-exempt regenerated byte, introducing a duplicate JSON
  key, or changing the exempt aggregate schema's key set, array order, or scalar values makes
  verification fail with a typed contract error; object-member reordering alone at the exact
  exempt path succeeds and is reported.
- [ ] Mutating method membership, generator mode, literal version, either hash, or the exact
  exception path makes verification fail with a typed contract error.

#### Runtime Verification

None required — regeneration equivalence, exact committed-byte integrity, schema compilation, and
stable-surface completeness are fully covered by automated checks in this phase.

---

## Phase 2: Prove bounded bidirectional JSONL transport over a real child process

### Overview

Add the real process seam, bounded stderr drain, serialized JSONL client, bidirectional in-memory
journal primitive, typed diagnostics, and a scripted fake child. The phase ends at ordered,
schema-validated transport records and does not interpret the conversation lifecycle or publish
evidence.

### Dependencies and Parallelism

- **Depends on**: Phase 1
- **Can run in parallel with**: None
- **Parallel ownership boundary**: Not applicable. This phase defines the process host, JSONL
  client, fixture, validator dispatch, transcript-record primitive, and close/status/stream
  interfaces consumed unchanged by Phases 3 and 4.
- **Execution note**: Concurrent phase runs require isolated worktrees and a parent-owned
  integration strategy.

### Changes Required

#### 2.1 Stable transport diagnostics

**File**: `spikes/codex-app-server/src/diagnostics.ts`

**Changes**:

- Add a typed diagnostic record with stable code, stage, expected/observed context, platform,
  executable path when known, protocol method/request ID when known, bounded supporting stderr,
  and an actionable next step.
- Cover process spawn/exit, framing, UTF-8, JSON, envelope classification, schema, correlation,
  queue, timeout, write, and close failures without making raw platform error text the contract.
- Redact credential-like environment values and direct personal paths before any diagnostic can be
  retained.

#### 2.2 Child-process ownership and independent drains

**File**: `spikes/codex-app-server/src/process_host.ts`

**Changes**:

- Bind launch behavior exactly to the documented `Deno.Command` process-host seam: executable plus
  argument array, explicit cwd/environment, and piped stdin/stdout/stderr.
- Expose the direct PID, writable stdin, readable stdout, readable stderr, direct-child
  `Deno.ChildProcess.status`, and one delegated close boundary. Do not interpret Codex lifecycle in
  this module.
- Start bounded stderr drainage immediately and independently of stdout. Retain only the
  manifest-limited diagnostic tail and a total observed byte count; never pass stderr bytes to the
  protocol parser.
- Route spawn errors, stream failures, and unexpected direct-child exit into the typed diagnostic
  and shared close path that Phase 4 completes.

#### 2.3 Bidirectional observation primitive

**File**: `spikes/codex-app-server/src/transcript.ts`

**Changes**:

- Add the new in-memory record contract from the normative TDD `ProtocolRecord` shape without
  publishing it to disk.
- Assign one monotonic `observationIndex` across client writes and complete server frames. Assign
  server-only `wireIndex` at complete-frame extraction, before UTF-8 decode, JSON parse, envelope
  classification, schema validation, or dispatch.
- Record validated client envelopes immediately before their exact bytes become visible to the
  serialized writer. Preserve raw diagnostic metadata for invalid server frames so failures remain
  positioned in inbound order.
- Record monotonic offsets as measurements, not ordering authority or performance thresholds.

#### 2.4 Bounded serialized JSONL client

**File**: `spikes/codex-app-server/src/jsonl_client.ts`

**Changes**:

- Implement one serialized stdin writer. Schema-validate and journal each client envelope
  immediately before writing exactly one newline-terminated JSON object.
- Allocate monotonic connection-local request IDs. Register a pending request before enqueue/write
  can expose it to the child; remove and reject it if enqueue or write fails. Settle each pending ID
  at most once.
- Use strict streaming UTF-8 decode and a byte-bounded line accumulator. Reject oversized complete
  lines and incomplete final frames; do not split, truncate, or accept multiple JSON values in one
  frame.
- Classify responses, server notifications, and server requests after indexing. Correlate responses
  by ID while preserving server-message arrival order independently.
- Feed validated non-response messages into a FIFO queue bounded separately by manifest
  `maxQueueMessages` and `maxQueueBytes`. Exact-boundary input succeeds; the first over-bound input
  fails the run without dropping or reordering the complete frame.
- Reject duplicate/unknown response IDs, a second initialize, methods before initialization,
  unknown exact-version methods after journaling, writes after close, EOF with pending requests,
  and reader/writer failure. Unknown server requests use only the generated method-not-found error
  shape before failing the compatibility run.

#### 2.5 Real subprocess fixture

**File**: `spikes/codex-app-server/tests/fixtures/fake_app_server.ts`

**Changes**:

- Implement mode-selected behavior over actual stdin/stdout/stderr pipes for split/coalesced
  frames, interleaved responses/notifications, fast responses, malformed UTF-8/JSON, unknown
  methods/IDs, oversized/incomplete lines, delayed reads, early EOF, pending requests, and
  manifest-boundary queue pressure.
- Generate high-volume stderr independently so tests can prove it cannot block stdout.
- Reserve fixture modes for ignored stdin closure, ignored signals, ordinary grandchildren,
  surviving grandchildren, and immediate session escape; Phase 4 owns their shutdown semantics.
- Drive assertions with protocol markers and child status, not arbitrary sleeps.

#### 2.6 Transport integration tests

**Files**:

- `spikes/codex-app-server/tests/jsonl_client_test.ts`
- `spikes/codex-app-server/tests/protocol_validation_test.ts`

**Changes**:

- Cover partial/multiple frames, serialized concurrent writes, fast register-before-write
  responses, interleaved correlation, duplicate/unknown IDs, and observation/wire order.
- Cover second initialization, pre-initialization and post-close writes, strict UTF-8/JSON,
  oversized lines, incomplete EOF, early exit, pending-request EOF, and independent stderr drain.
- Test message-count and retained-byte boundaries independently and together. Verify no complete
  frame disappears when the queue fails.
- Extend generated-schema dispatch across exercised client and server envelopes. Prove malformed
  and unknown frames are indexed and diagnostically retained before the exact-version run fails.

### Success Criteria

#### Automated Verification

- [ ] `deno task test:transport`
- [ ] `deno task protocol:verify`
- [ ] Exact queue count/byte boundaries pass and the first over-bound message produces the expected
  typed failure without loss or reordering.
- [ ] A response emitted as soon as the child observes a request correlates successfully, proving
  registration precedes visibility to the child.
- [ ] Large bounded stderr output cannot stall stdout consumption and never appears as a protocol
  record.

#### Runtime Verification

None required — the automated tests launch the fake app-server as a real subprocess over real
stdio, covering this phase's runtime boundary.

---

## Phase 3: Prove preflight, lifecycle, transcript, and coverage behavior offline

### Overview

Compose the Phase 2 transport into the complete required scenario using scripted fake-child
behavior. Prove environment diagnostics, initialization/authentication policy, bounded model
pagination, native identity/lifecycle rules, raw-before-redaction validation, schema-valid retained
evidence, and bidirectional journal-derived coverage without credentials, network access, committed
evidence writes, or an absolute shutdown claim.

### Dependencies and Parallelism

- **Depends on**: Phase 1 and Phase 2
- **Can run in parallel with**: Phase 4
- **Parallel ownership boundary**: This phase exclusively owns `scripts/run-protocol-spike`,
  `src/preflight.ts`, `src/lifecycle_scenario.ts`, lifecycle/redaction behavior in
  `src/transcript.ts`, journal-derived behavior in `src/coverage.ts`,
  `schemas/evidence.schema.json`, `tests/preflight_test.ts`, and
  `tests/transcript_test.ts`. Phase 4 owns shutdown, Darwin lineage tracking, shutdown-only fixture
  modes, and shutdown tests. Neither phase changes the public Phase 2 host/client record,
  stream/status, or close contracts.
- **Execution note**: Concurrent phase runs require isolated worktrees and a parent-owned
  integration strategy.

### Changes Required

#### 3.1 Developer launcher and preflight diagnostics

**Files**:

- `scripts/run-protocol-spike`
- `spikes/codex-app-server/src/preflight.ts`

**Changes**:

- Make the launcher executable and responsible only for detecting a missing developer Deno,
  emitting `DENO_NOT_FOUND` with exact expected version and recovery action, and handing off to the
  named Deno task. It must not locate, assemble, or launch Codex.
- In Deno preflight, require `Deno.version.deno === "2.9.3"`, resolve Codex without a shell, map
  `Deno.errors.NotFound` to `CODEX_NOT_FOUND`, require exact `codex-cli 0.145.0`, verify the
  generated bundle, and enforce the manifest platform for both live tasks (`spike:verify` and
  `spike:accept`). Deterministic tests may inject fake platform probes.
- Perform initialize/initialized and `account/read` before any thread/turn request. Authentication
  succeeds when `account !== null`; do not reject a non-null account solely because
  `requiresOpenaiAuth` is true.
- Emit stable `DENO_VERSION_MISMATCH`, `CODEX_VERSION_MISMATCH`, `CODEX_AUTH_REQUIRED`,
  `ARTIFACT_MISMATCH`, and `PLATFORM_UNSUPPORTED` diagnostics with expected, observed, stage,
  platform, resolved path when known, and next action.

#### 3.2 Retained evidence schema

**File**: `spikes/codex-app-server/schemas/evidence.schema.json`

**Changes**:

- Validate both client and server retained records, shared observation order, server-only wire
  order, schema proof, native thread/turn/item indexes, monotonic measurements, bounded shutdown
  facts, fixed hash names, terminal status, and every acceptance gate.
- Require same-type redaction placeholders and reject credential-like fields, direct account
  identifiers, or raw home/repository paths.
- Keep `noObservedDescendantsRemain` and `escapedDescendantContainmentProven` as separate required
  facts. Do not derive one from the other in schema defaults.

#### 3.3 Bounded lifecycle scenario

**File**: `spikes/codex-app-server/src/lifecycle_scenario.ts`

**Changes**:

- Create a new temporary directory, run `git init` through an argument-array command, verify it is
  a Git repository, and remove it in `finally`.
- Execute exactly one initialize/initialized pair, `account/read`, and all `model/list` pages before
  `thread/start`. Treat null or absent `nextCursor` as terminal; reject a repeated non-null cursor,
  manifest page exhaustion, or manifest catalog deadline before thread creation.
- Select a visible model from returned data and run `thread/start`, `turn/start`, streamed
  item/lifecycle handling, and terminal turn handling against the fake server.
- Keep connection request IDs distinct from native thread, turn, and item identities. Accept
  interleaved responses/notifications when correlation and semantic order remain valid.
- Require one terminal `completed` turn and at least one non-empty completed agent message.
  `interrupted` and `failed` are schema-valid terminal states but fail compatibility.
- Ensure every preflight failure proves that no `thread/start` or `turn/start` was written.

#### 3.4 Lifecycle validation and schema-preserving redaction

**File**: `spikes/codex-app-server/src/transcript.ts`

**Changes**:

- Add a lifecycle reducer bound to the architecture's **Identity**, **Connection and thread
  lifecycle**, and **Turn lifecycle** invariants: initialize once, native thread continuity, native
  turn continuity, item start/delta/completion ordering, terminal turn identity, and no unmatched
  pending response.
- Reconstruct agent text from ordered deltas and compare it with the completed item. Reject deltas
  before start, duplicate start/completion, deltas after completion, incomplete items at terminal
  turn, and mismatched native IDs.
- Validate every raw decoded client/server envelope against the pinned schema before redaction.
  Redact prompt/response text into deterministic hash-bearing strings, paths into stable
  placeholders, and account identifiers into same-type pseudonyms; reject credential-like data
  rather than trying to preserve it.
- Revalidate every redacted envelope against its pinned protocol schema and every evidence-only
  field against the local evidence schema. Temporary raw data never reaches committed paths and is
  removed in `finally`.
- Preserve one retained record per client protocol write and complete server stdout frame in
  observation order. Preserve server `wireIndex` as the authoritative inbound order.

#### 3.5 Journal-derived coverage

**File**: `spikes/codex-app-server/src/coverage.ts`

**Changes**:

- Derive outbound counts from schema-valid client records and inbound counts from schema-valid
  server records. Never attempt to infer client activity from a server-only transcript.
- Require complete generated membership while deriving `exercised` only for observed records.
  Keep absent optional methods schema-validated-unexercised; retain supported intentional-ignore
  and unsupported classifications with rationales.
- Fail if supplied coverage counts or dispositions disagree with the journal. Return the derived
  result in memory or a temporary path; verify-only behavior must not mutate committed
  `coverage.json`.

#### 3.6 Offline scenario tests

**Files**:

- `spikes/codex-app-server/tests/preflight_test.ts`
- `spikes/codex-app-server/tests/transcript_test.ts`

**Changes**:

- Cover missing/mismatched Deno, missing/mismatched Codex, artifact mismatch, unsupported live
  platform, null account, non-null account with `requiresOpenaiAuth: true`, and no authenticated
  work after a failed gate.
- Cover absent/null/repeated model cursors, page exhaustion, catalog deadline, and proof that
  `thread/start` follows successful catalog completion only.
- Cover native request/thread/turn/item identity separation, impossible lifecycle transitions,
  delta reconstruction, incomplete and non-completed turns, and empty completed agent text.
- Cover pre-redaction schema rejection, sensitive-field rejection, deterministic same-type
  replacements, post-redaction protocol validation, evidence-schema validation, observation/wire
  ordering, and both-direction coverage derivation.
- Run the entire required lifecycle through the real fake-child pipes and assert one initialization,
  bounded pagination, one completed turn, non-empty agent text, and no committed evidence changes.

### Success Criteria

#### Automated Verification

- [ ] `deno task test:lifecycle`
- [ ] `deno task protocol:verify`
- [ ] The scripted full-lifecycle fake scenario completes with one initialize/initialized pair,
  bounded catalog completion, one native thread/turn, ordered complete items, and a non-empty
  completed agent message.
- [ ] Every failing preflight has the expected stable diagnostic and records no thread or turn
  request.
- [ ] Baseline and temporary journal-derived coverage both validate, while committed
  `spikes/codex-app-server/coverage.json` remains unchanged.
- [ ] Raw and redacted validation failures prevent any retained output, and successful retained
  data contains no credential, raw prompt/response, direct account ID, home path, or repository
  path.

#### Runtime Verification

None required — this phase intentionally exercises the complete policy with deterministic
fake-child runtime behavior so every outcome is automated and credential-free.

---

## Phase 4: Prove bounded observed-tree shutdown and preserve escape diagnostics

### Overview

Implement one memoized shutdown state machine for every process exit path, plus the macOS arm64
process-group and observed-lineage boundary. This phase completes when ordinary graceful,
`SIGTERM`, and `SIGKILL` paths are deadline-bounded; direct status and both drains settle; unsafe
identity, timeout, and remaining-process states fail; ordinary descendants are removed; and the
final observation yields `noObservedDescendantsRemain: true`.

Snapshot observations and absolute containment remain separate. The real immediate-`setsid`/
reparent fixture stays a cleanup-safe negative limitation test: it must surface `DESCENDANT_LEAK`
plus tracker/containment diagnostics and keep `escapedDescendantContainmentProven: false`. Passing
that expected negative test does not prove containment and does not block Phase 4 completion.
`TRACKER_UNAVAILABLE` and `CONTAINMENT_UNPROVEN` are retained limitation diagnostics rather than
selected fatal failures when the supported observed-tree shutdown path itself succeeds.

### Dependencies and Parallelism

- **Depends on**: Phase 1 and Phase 2
- **Can run in parallel with**: Phase 3
- **Parallel ownership boundary**: This phase exclusively owns `src/shutdown.ts`,
  `src/process_tree_darwin.ts`, shutdown integration in `src/process_host.ts`, shutdown diagnostics
  in `src/diagnostics.ts`, shutdown-only modes in `tests/fixtures/fake_app_server.ts`, and
  `tests/shutdown_test.ts`. It also owns only the cleanup-acceptance amendment in
  `schemas/evidence.schema.json` and its focused assertions in `tests/transcript_test.ts`; completed
  Phase 3 lifecycle, redaction, and coverage behavior remains unchanged. Both phases consume the
  fixed Phase 2 host/client contracts.
- **Execution note**: Concurrent phase runs require isolated worktrees and a parent-owned
  integration strategy.

### Changes Required

#### 4.1 Revised cleanup evidence contract

**Files**:

- `spikes/codex-app-server/schemas/evidence.schema.json`
- `spikes/codex-app-server/tests/transcript_test.ts`

**Changes**:

- Preserve both required shutdown facts. An accepted MVP summary requires
  `noObservedDescendantsRemain: true`; `escapedDescendantContainmentProven` is a required boolean
  evidence fact but is not part of the all-true acceptance-gate set.
- Expand `AcceptanceSummary.shutdown` to retain the implemented structured shutdown evidence:
  owned root/group/session identity, observed PIDs and lineage events, signal path and timed-out
  stages, recorded direct exit, completed stdout/stderr drains, bounded timings, `remainingPids`,
  containment-capability evidence, both cleanup facts, and bounded diagnostics. Accepted evidence
  requires a recorded direct exit, both drains complete, `remainingPids: []`, and
  `noObservedDescendantsRemain: true`.
- Remove `escapedDescendantContainmentProven` from `AcceptanceSummary.gates`. Keep it under
  structured shutdown evidence, false for snapshot-only operation. If any future implementation
  supplies true, require capability fields proving pre-exec arming, continuous creation/session/
  reparent coverage without loss or overflow, and final absence of every tracked PID; snapshots,
  sampling frequency, and group-signal success can never set it.
- Test that `noObservedDescendantsRemain: true` plus
  `escapedDescendantContainmentProven: false` is schema-valid and eligible for later MVP
  acceptance. Reject a missing proof fact, a false `noObservedDescendantsRemain`, a remaining PID,
  or a true proof claim without the separately validated proof evidence.

#### 4.2 Memoized bounded shutdown controller

**File**: `spikes/codex-app-server/src/shutdown.ts`

**Changes**:

- Memoize the first close operation so concurrent close calls share one promise, evidence object,
  and signal path.
- Stop new work, reject or settle all pending requests, and request generated `turn/interrupt`
  only when a native turn is active. Then close stdin and await direct status within the manifest
  graceful bound.
- If needed, signal only a verified positive-root owned process group with `SIGTERM`, await the
  manifest terminate bound, then use `SIGKILL` and the manifest force bound.
- Await stdout/stderr drains and direct-child status on every path, including success, protocol
  failure, timeout, cancellation, unexpected server request, and child exit.
- Return structured evidence containing root/session identity, descendants observed, signal path,
  direct exit, timings, remaining PIDs, `noObservedDescendantsRemain`, containment capability
  evidence, and `escapedDescendantContainmentProven`.
- Make timeout, unsafe root/group identity, failed direct exit/drains, and any remaining process
  typed failures. Preserve tracker-unavailable and containment-unproven diagnostics without
  selecting them as fatal when bounded observed cleanup succeeds. No error path may skip the
  cleanup attempt or overwrite stronger prior evidence.

#### 4.3 Darwin process-group and observed-lineage boundary

**File**: `spikes/codex-app-server/src/process_tree_darwin.ts`

**Changes**:

- Validate `darwin`/`aarch64` before making any supported-platform claim. Record the direct PID,
  owned session/process-group identity, transitive descendants, group membership, lineage events,
  tracker overflow/loss state, and final presence.
- Implement snapshot inspection only as observational evidence. An empty final snapshot may set
  `noObservedDescendantsRemain` when all observed PIDs and group members are absent, but this path
  must always leave `escapedDescendantContainmentProven` false.
- Record tracker unavailability, loss, late start, overflow, unlinked reparenting, or inability to
  terminate an escaped PID as containment-limitation evidence and keep the proof flag false. Those
  states remain fatal for any absolute-containment claim, but tracker unavailability alone is not
  fatal to the scoped observed-tree MVP gate.
- Put any future proof-producing path behind a capability armed before child code can execute and
  continuously covering process creation, session/group escape, reparenting, and exit through
  final verification without gaps or overflow. The proof flag may be true only when that
  capability accounts for every lineage event and terminates every tracked descendant.
- Do not infer proof from sampling frequency, repeated empty snapshots, the direct child's
  cooperation, or successful group signals.
- Guard `Deno.kill` negative-PID operations by re-reading and matching the owned positive root,
  session, and process-group identity immediately before each signal.

#### 4.4 Spawn-to-shutdown integration

**File**: `spikes/codex-app-server/src/process_host.ts`

**Changes**:

- Create an owned session/process group, capture the root/group identity, and begin observation
  before allowing the child work to proceed through the host boundary. If no race-closing tracker
  exists, expose containment as unavailable, keep the proof flag false, and continue only with the
  scoped observed-tree cleanup contract.
- Wire the direct status and both drain promises into the memoized shutdown controller.
- Route normal completion, spawn-after-start failure, protocol/schema failure, request timeout,
  cancellation, unexpected request, stream failure, and unexpected child exit through the same
  close promise.
- Keep platform inspection/signaling in the Darwin boundary; the generic process host must not
  parse process-table output or claim descendant proof.

#### 4.5 Shutdown diagnostics

**File**: `spikes/codex-app-server/src/diagnostics.ts`

**Changes**:

- Add stable diagnostics for unsafe process-group identity, graceful/terminate/force timeout,
  `DESCENDANT_LEAK`, tracker unavailable/lost/overflowed, and containment unproven.
- Include shutdown stage, verified root/group identity, observed and remaining PIDs, and signal
  path. Keep snapshot evidence and proof-capability evidence separately labeled.
- Ensure human-facing text distinguishes fatal observed-tree cleanup failures from the unsupported
  absolute-containment limitation. It must not claim escaped-descendant containment when proof is
  unavailable, but it must not report that limitation alone as an MVP compatibility failure.

#### 4.6 Adversarial shutdown fixture modes

**File**: `spikes/codex-app-server/tests/fixtures/fake_app_server.ts`

**Changes**:

- Complete deterministic modes for graceful exit, ignored stdin close, ignored `SIGTERM`, ordinary
  grandchildren, grandchildren surviving the direct parent, and immediate session escape plus
  reparenting.
- Make the escape fixture attempt `setsid` at the earliest executable point and emit only bounded
  synchronization/identity markers that do not themselves serialize or delay containment.
- Give each fixture a cleanup-safe control path for a failing test harness so a negative test cannot
  intentionally leave a process behind.

#### 4.7 Shutdown and limitation tests

**File**: `spikes/codex-app-server/tests/shutdown_test.ts`

**Changes**:

- Cover concurrent close calls, each close entry path, graceful/TERM/KILL escalation, direct status
  and drain completion, root/session/group guards, ordinary descendant cleanup, and remaining-PID
  failure.
- Assert snapshot-only inspection can set at most `noObservedDescendantsRemain: true` and always
  leaves `escapedDescendantContainmentProven: false`.
- Run the immediate-`setsid`/reparent fixture through the actual platform boundary, not a mocked
  boolean. Require it to demonstrate the unsupported escape, produce `DESCENDANT_LEAK` and
  tracker/containment diagnostics, leave the proof flag false, and use its cleanup-safe control
  path so the test itself leaves no process behind. Treat this expected negative result as a
  passing limitation test, not a Phase 4 blocker.
- Assert a remaining PID or unverifiable signal target is fatal for that shutdown attempt.
  Unavailable/lost/overflowed tracking keeps the proof flag false and prevents any absolute claim
  but does not fail a different ordinary shutdown attempt whose bounded final observed set is
  empty.
- Prove protocol failure, timeout, unexpected request, child exit, and cancellation all return the
  same memoized shutdown evidence rather than independent cleanup attempts.

### Success Criteria

#### Automated Verification

- [ ] `deno task test:shutdown`
- [ ] Graceful, `SIGTERM`, and `SIGKILL` fixtures terminate within the manifest bounds and leave no
  direct child or observed descendant.
- [ ] Snapshot-only testing yields `escapedDescendantContainmentProven: false` even when
  `noObservedDescendantsRemain: true`.
- [ ] The immediate-`setsid`/reparent fixture produces `DESCENDANT_LEAK` plus tracker/containment
  diagnostics, leaves `escapedDescendantContainmentProven: false`, and is removed by the
  cleanup-safe harness without being misreported as contained.
- [ ] Disabling, delaying, overflowing, or losing the lineage capability leaves the proof flag
  false and prevents an absolute-containment claim without blocking an otherwise clean
  observed-tree result.
- [ ] Every success/failure/cancellation entry path shares one close promise, waits for status and
  drains, and records the same evidence object for concurrent callers.

#### Runtime Verification

None required — shutdown, including the adversarial escaped-descendant limitation case, must be a
repeatable automated macOS arm64 integration test. Manual process-table observation cannot
complete this phase. The real pinned Codex observed-tree gate is exercised in Phase 5.

---

## Phase 5: Complete the authenticated compatibility run in verify-only mode

### Overview

Compose the exact artifacts, preflight, lifecycle, transcript, coverage evaluator, measurements,
and revised bounded shutdown boundary into the user-invoked harness. Run one real authenticated turn and
produce candidate evidence in memory/temporary storage only. This phase proves the live boundary
without changing committed coverage or evidence.

### Dependencies and Parallelism

- **Depends on**: Phase 3 and Phase 4
- **Can run in parallel with**: None
- **Parallel ownership boundary**: Not applicable. This integrated phase consumes every earlier
  contract. It may begin after the freshly retried Phase 4 passes its revised bounded
  observed-tree gate; unavailable absolute containment is not a dependency blocker.
- **Execution note**: Concurrent phase runs require isolated worktrees and a parent-owned
  integration strategy.

### Changes Required

#### 5.1 Verify-only CLI composition

**Files**:

- `deno.json`
- `spikes/codex-app-server/src/main.ts`

**Changes**:

- Extend both live tasks with the already-implemented bounded shutdown executables while preserving
  their existing read/write scopes:

  ```json
  "spike:verify": "deno run --allow-read=.,/tmp --allow-write=/tmp --allow-run=/opt/homebrew/bin/codex,/usr/bin/git,/usr/bin/python3,/bin/ps,/bin/kill spikes/codex-app-server/src/main.ts verify",
  "spike:accept": "deno run --allow-read=.,/tmp --allow-write=spikes/codex-app-server/evidence,spikes/codex-app-server/coverage.json,/tmp --allow-run=/opt/homebrew/bin/codex,/usr/bin/git,/usr/bin/python3,/bin/ps,/bin/kill spikes/codex-app-server/src/main.ts accept"
  ```

- Compose compatibility loading, generated-bundle verification, platform/version preflight,
  disposable repository creation, process/session startup, lifecycle execution, shutdown,
  coverage/evidence evaluation, and stable exit diagnostics.
- Make verify-only the default path behind `deno task spike:verify`. It may use temporary files but
  must never replace committed coverage, transcript, summary, compatibility, or generated inputs.
- Enforce one `finally` cleanup path for raw memory/temp capture, temporary repository, temporary
  candidate evidence, protocol session, and process tracker.
- Return non-zero with the typed blocker for exact-version, artifact, platform, auth, protocol,
  lifecycle, redaction, observed-tree shutdown, or cleanup failure. Tracker unavailability or a
  false escaped-containment proof flag alone is a retained limitation, not a live-task blocker.

#### 5.2 Real pinned lifecycle and measurements

**File**: `spikes/codex-app-server/src/lifecycle_scenario.ts`

**Changes**:

- Bind the fixed benign text prompt, read-only sandbox, no-approval policy, selected visible model,
  exact temporary Git cwd, and one-turn constraint to the pinned generated parameter schemas.
- Use the caller-selected `CODEX_HOME` exactly as supplied; do not create, copy, edit, or bootstrap
  authentication.
- Require initialize/initialized, non-null account, all model pages, thread start, turn start,
  streamed item output, a non-empty completed agent message, and terminal `turn/completed`.
- Measure spawn-to-initialize-response, initialize-to-ready, turn-start-to-first-event,
  turn-start-to-completed, stdin-close-to-exit, and total shutdown using monotonic time. Apply only
  manifest safety bounds, not new performance thresholds.

#### 5.3 In-memory candidate evidence

**File**: `spikes/codex-app-server/src/transcript.ts`

**Changes**:

- Produce the redacted candidate bidirectional journal and summary inputs only after raw protocol,
  semantic lifecycle, post-redaction protocol, local evidence, and shutdown validation succeed.
- Scan candidate retained values and bounded stderr diagnostics for credential-like fields, raw
  prompt/response text, account identifiers, and home/repository paths before declaring the
  candidate eligible.
- Require exact versions, current generated hash, complete run-derived coverage, ordered lifecycle,
  authenticated completion, settled direct status and drains, empty `remainingPids`, and
  `noObservedDescendantsRemain: true`. Preserve `escapedDescendantContainmentProven` as a required
  shutdown evidence fact; false is the expected snapshot-only MVP value and is not a blocker.
  Reject it if absent or if it is true without separately validated race-closing proof.

#### 5.4 Explicit authenticated integration test

**File**: `spikes/codex-app-server/tests/authenticated_turn_test.ts`

**Changes**:

- Add a separately tagged/explicitly enabled test using the exact CLI, caller-selected authenticated
  home, a new temporary Git repository, and the full live lifecycle. Bind enablement to the
  repository's named live-test environment contract rather than running in deterministic CI.
- Assert native identity/order, non-empty completed agent content, generated-schema validity before
  and after redaction, all measurements present, bounded stderr separation, complete coverage, and
  clean bounded observed-tree shutdown of the actual Codex CLI `0.145.0` app-server process tree.
  Require `noObservedDescendantsRemain: true` and an accurate
  `escapedDescendantContainmentProven` fact; do not require the latter to be true.
- Do not assert exact assistant prose or the presence of optional notifications.
- Capture enough failure diagnostics to identify the blocking gate without retaining raw sensitive
  payloads.

### Success Criteria

#### Automated Verification

- [ ] `deno task check`
- [ ] `deno task spike:verify`
- [ ] The live run records every required measurement without adding performance limits beyond the
  manifest safety bounds.
- [ ] Required methods/events are schema-valid and semantically ordered; optional notifications are
  classified from observation; stderr contributes no protocol records.
- [ ] The candidate contains no credential, raw prompt/response, direct account identifier, home
  path, or repository path.
- [ ] Exact versions, generated artifacts, coverage completeness, lifecycle, authentication,
  settled direct status/drains, empty `remainingPids`, and
  `noObservedDescendantsRemain: true` are all satisfied before verify-only reports success.
- [ ] `escapedDescendantContainmentProven` remains present and false unless separately validated
  race-closing proof exists; its accurate false value does not fail the pinned-run verification.
- [ ] A hash of each committed coverage/evidence path before and after `deno task spike:verify`
  remains identical.

#### Runtime Verification

None beyond `deno task spike:verify` — that command is the reproducible authenticated runtime check.
An unsuitable environment must return a structured blocker rather than invite a manual bypass.

---

## Phase 6: Publish and re-verify one atomic acceptance proof set

### Overview

Add the explicit acceptance publisher and use it to stage, validate, and replace the run-derived
coverage manifest, redacted bidirectional journal, and cross-hashed summary. Reader-visible
acceptance is fail-closed: a crash between fixed-path replacements may leave a partial disk state,
but that state must derive candidate status until all three artifacts and immutable hashes agree.

### Dependencies and Parallelism

- **Depends on**: Phase 5
- **Can run in parallel with**: None
- **Parallel ownership boundary**: Not applicable. This phase owns the sole transition from a
  verified in-memory run to committed acceptance artifacts.
- **Execution note**: Concurrent phase runs require isolated worktrees and a parent-owned
  integration strategy.

### Changes Required

#### 6.1 Canonical run-derived coverage

**Files**:

- `spikes/codex-app-server/src/coverage.ts`
- `spikes/codex-app-server/coverage.json`

**Changes**:

- Serialize the complete generated-surface coverage in stable key order with a final newline,
  generated bundle binding, journal-derived counts, and dispositions consistent with those counts.
- Replace the zero-observation baseline only from `spike:accept` after all acceptance-required live
  gates pass.
  Verification and ordinary test paths remain read-only.

#### 6.2 Canonical retained journal

**Files**:

- `spikes/codex-app-server/src/transcript.ts`
- `spikes/codex-app-server/evidence/authenticated-turn.redacted.jsonl`

**Changes**:

- Serialize exactly one canonical newline-terminated JSON object per retained record in ascending
  observation order, preserving ascending server wire order.
- Calculate the transcript hash over the exact staged bytes and revalidate all pinned protocol and
  local evidence schemas from staged bytes before publication.
- Publish no raw transcript, stderr log, temporary repository path, or unredacted sidecar.

#### 6.3 Cross-hashed summary and publication

**Files**:

- `spikes/codex-app-server/src/main.ts`
- `spikes/codex-app-server/evidence/authenticated-turn.summary.json`

**Changes**:

- Implement `deno task spike:accept` as a new live run followed by staging under a temporary sibling
  on the same filesystem.
- Build the normative TDD `AcceptanceSummary`: exact versions/platform, current compatibility and
  generated hashes, staged coverage/transcript hashes, lifecycle counts/IDs, required
  measurements, structured shutdown evidence, terminal completed status, and the revised
  acceptance-required gates. The required true gate set is exactly `exactVersions`,
  `generatedArtifactsMatch`, `coverageComplete`, `everyRetainedEnvelopeSchemaValid`,
  `lifecycleOrdered`, `authenticatedTurnCompleted`, and `noObservedDescendantsRemain`.
  `escapedDescendantContainmentProven` remains a required field in shutdown evidence, outside that
  all-true set.
- Validate compatibility/generated inputs again immediately before publication. Validate staged
  coverage, transcript, summary, cross-hashes, canonical bytes, sensitive-data scan, and every
  acceptance-required gate as one set. Require direct child exit, completed drains, empty
  `remainingPids`, and `noObservedDescendantsRemain: true`; accept an accurate false
  `escapedDescendantContainmentProven`, but reject a missing fact or a true value without validated
  race-closing proof.
- Replace only the three fixed run-derived outputs. Immutable compatibility and generated inputs
  remain untouched. Use same-filesystem replacement for each output and retain no success marker
  outside the cross-hashed summary.
- On startup and after publication, derive validated status only when the entire on-disk set agrees.
  Missing, stale, singly replaced, partially replaced, malformed, false acceptance-required gate,
  remaining observed PID, unsupported proof claim, or mismatched artifacts derive candidate
  status.

#### 6.4 Proof-set rejection tests

**File**: `spikes/codex-app-server/tests/config_test.ts`

**Changes**:

- Add temporary proof-set cases for a missing member, one replaced member, changed immutable
  manifest, changed generated byte, stale coverage, stale transcript, wrong hash, false/absent
  acceptance-required gate, missing shutdown fact, remaining observed PID,
  `escapedDescendantContainmentProven: true` without proof evidence, non-canonical bytes, and
  interrupted replacement at each fixed output.
- Assert every partial/mismatched case derives candidate status and cannot be interpreted as a
  validated pair.
- Prove successful staged and published sets recalculate to the same hashes, preserve complete
  stable-surface membership, remain schema-valid after redaction, contain a completed turn, and
  contain clean bounded observed-tree shutdown. Explicitly prove that
  `noObservedDescendantsRemain: true` with `escapedDescendantContainmentProven: false` remains
  eligible, while neither an absent proof fact nor an unsupported true proof claim is eligible.

### Success Criteria

#### Automated Verification

- [ ] `deno task spike:accept`
- [ ] `deno task protocol:verify`
- [ ] `deno task check`
- [ ] Recalculate compatibility, generated-bundle, coverage, and transcript hashes from disk and
  verify exact equality with the published summary.
- [ ] Removing or replacing any single proof artifact, changing any immutable input, flipping any
  acceptance-required gate, or simulating each interrupted replacement derives candidate rather
  than validated status.
- [ ] The committed journal validates after redaction, coverage equals the complete generated
  stable surface and journal observations, the terminal turn is completed, direct status and
  drains are complete, `remainingPids` is empty, and `noObservedDescendantsRemain` is true.
- [ ] The published summary retains `escapedDescendantContainmentProven`; false is accepted and
  accurately documents the unsupported immediate-`setsid` limitation, while true is rejected
  unless validated race-closing proof accompanies it.
- [ ] Re-running `deno task protocol:verify` after publication performs no writes and re-verifies
  the generated bundle plus current complete coverage membership. Complete on-disk proof-set
  revalidation remains part of `spike:accept` and its acceptance evaluator.

#### Runtime Verification

None required — the explicit acceptance task performs the live run, staged publication, and
post-publication revalidation as one automated gate.

---

## Evidence Gaps

- Stable generation by Codex CLI `0.145.0` has now repeatedly produced 617 TypeScript and 273 JSON
  Schema files. These are observed evidence and still must not be hard-coded as generator acceptance
  values. The exact committed file tree and its raw `bundleSha256` remain unknown until Phase 1
  selects one clean unmodified output; the deterministic `regenerationSha256` is established from
  the narrow comparison contract above rather than from whole-tree raw equality.
- `07-structure-outline.md` still says a fresh regeneration must match one deterministic raw bundle
  hash; `05-tdd.md` still defines reproducibility solely as path-sorted
  `path + NUL + bytes + NUL` equality; `04-design-discussion.md` still calls unmodified generation
  reproducible under one deterministic bundle hash; and `06-red-team-design.md` still records the
  raw path-and-byte strategy as passed. This fact-check skill may update only this plan and its new
  report, so those upstream artifacts remain unchanged. For Phase 1 implementation, this plan's
  two-hash contract supersedes those raw-only regeneration statements; the supervisor should align
  all four upstream artifacts before any later workflow treats their wording as independently
  normative.
- **User-approved MVP descoping**: the ticket, revised design discussion, revised TDD, red-team
  disposition, and historical Phase 4 ledger encode absolute containment of arbitrary descendants
  more strongly than the revised acceptance criterion. For this plan, bounded clean shutdown of the
  actual pinned Codex CLI `0.145.0` app-server process tree observed during the live run supersedes
  that absolute wording. The immediate-`setsid`/reparent fixture remains implemented, diagnosed,
  cleanup-safe, and explicitly unsupported; it must keep
  `escapedDescendantContainmentProven: false` and must never be cited as proven containment, but it
  no longer blocks Phases 4–6 when their revised observed-tree gates pass. No upstream artifact is
  edited by this fact-check.
- The selected pair remains a candidate until Phases 5 and 6 complete with an already-authenticated
  selected `CODEX_HOME`, the exact platform and versions, every acceptance-required gate true, and
  an accurate separately retained escaped-containment proof fact.
- Startup, first-event, completion, and shutdown observations remain unknown until the live run.
  Record them under manifest safety bounds without inventing performance thresholds.
- Optional live notifications remain data-dependent. Derive them from the accepted journal and do
  not make their presence an acceptance requirement.

## Run Ledger

| Phase | Implementation profile(s) | Files changed | Commit | Gate results | Review | Blockers / follow-up |
| ----- | ------------------------- | ------------- | ------ | ------------ | ------ | -------------------- |
| Phase 1 | `implementer-sol-high` | None (implementation stopped before repository edits; this ledger row only) | None | **Blocked before phase gates.** Exact temporary Deno `2.9.3`, Codex CLI `0.145.0`, Git `2.50.1`, and Darwin arm64 preflight passed. Three stable generations each produced 617 TypeScript and 273 JSON Schema files, but normative bundle hashes differed: `2e24a97759223e6770672822e362c321c89f158326f819688470d7d5e4f7f3f7`, `5f12389a18f5b513d8bf4c43a83092e38d056be4963924101bf01293ca1ac99d`, and `c2ed736ad2559704716dd63df09008aa9406832676fdccd578d609752d0064a6`. `diff -qr` isolated the byte difference to `json-schema/codex_app_server_protocol.v2.schemas.json`; canonicalized JSON compared equal. | Root independently reproduced file counts, all three normative hashes, the differing aggregate-schema bytes, and semantic equality after key sorting. No implementation review was possible because work stopped pre-edit. | Codex CLI `0.145.0` stable generation is byte-nondeterministic due to `definitions` object ordering, so the plan's unmodified-byte whole-bundle reproducibility gate cannot pass. Revise the plan or use an upstream deterministic generator before retrying Phase 1. |
| Phase 1 | `implementer-sol-high` | `deno.json`; immutable compatibility and coverage records/schemas; `generated/0.145.0/generation.json`; 617 generated TypeScript files; 273 generated JSON Schema files; `src/config.ts`, `src/generate_protocol.ts`, `src/protocol_validation.ts`, `src/coverage.ts`, `src/run_deterministic_tests.ts`; and three Phase 1 contract test files | None (left uncommitted for supervisor) | **Passed.** Exact temporary Deno `2.9.3` at `/tmp/vantage-deno-2.9.3.WgHO8X/deno`, Codex CLI `0.145.0`, Git `2.50.1`, Darwin arm64. Root independently reran `deno task protocol:generate`, `deno task protocol:verify`, `deno task test:contract` (16/16), and `deno task check`; all passed. Two independent fresh regenerations matched path sets/counts and raw bytes outside the named aggregate-schema exception. Raw committed hash `f6704018971b3b5e4ea0ffcd3e73b8d7dee4fd50435ed59467639936cb0e19c1`; deterministic regeneration hash `c1c45e67f86e39e5c65c858865e7ef90d32d3adf3354107ffe24a80c3973ca78`; coverage contains 170 unique zero-observation methods. | One root post-validation review found and fixed five true positives through the same implementer: caller-forgeable regeneration state, missing load-time coverage-membership validation, hard-coded observed counts in tests, incomplete future deterministic-suite dispatch from `check`, and an unrestricted `deno eval` dispatcher. Final review verification found no remaining Phase 1 issue. | None. Phase 1 is complete; later deterministic suites remain intentionally skipped until their phase-owned test files exist. |
| Phase 2 | `implementer-sol-high` | `src/diagnostics.ts`, `src/process_host.ts`, `src/transcript.ts`, `src/jsonl_client.ts`, `src/protocol_validation.ts`, `src/run_deterministic_tests.ts`, `tests/fixtures/fake_app_server.ts`, `tests/jsonl_client_test.ts`, and `tests/protocol_validation_test.ts` | None (left uncommitted for supervisor) | **Passed.** Exact temporary Deno `2.9.3` at `/tmp/vantage-deno-2.9.3.WgHO8X/deno`, Codex CLI `0.145.0`, Git `2.50.1`, Darwin arm64. Root independently reran `deno task test:transport` (21/21), `deno task protocol:verify` (617 TypeScript and 273 JSON Schema files; only the named aggregate-schema ordering exception), `deno task check` (16 contract and 21 transport tests; future lifecycle/shutdown suites skipped), and `git diff --check`; all passed. | One root post-validation review found and fixed five true positives through the same implementer: invocation-specific temporary Deno paths in checked-in task permissions, an accumulator that could exceed the configured line bound, queued writes that could execute after transport failure, close failure leaving message waiters unsettled, and missing delayed-read plus explicit Phase 4 fixture-mode reservations. Targeted fix verification passed; no further review pass was run. | None. Phase 2 is complete; Phase 4 still owns signal escalation, process-tree containment, and completed shutdown evidence. |
| Phase 3 | `implementer-sol-high` | `deno.json`, `scripts/run-protocol-spike`, `src/preflight.ts`, `src/lifecycle_scenario.ts`, lifecycle/redaction additions in `src/transcript.ts`, journal-derived additions in `src/coverage.ts`, `schemas/evidence.schema.json`, Phase 3 lifecycle modes in `tests/fixtures/fake_app_server.ts`, `tests/preflight_test.ts`, and `tests/transcript_test.ts` | None (left uncommitted for supervisor) | **Passed.** Exact temporary Deno `2.9.3` at `/tmp/vantage-deno-2.9.3.WgHO8X/deno` with its directory prepended to `PATH` for real-child fixtures, Codex CLI `0.145.0`, Git `2.50.1`, Darwin arm64. Root independently reran `deno task test:lifecycle` (20/20), `deno task protocol:verify` (617 TypeScript and 273 JSON Schema files; only the named aggregate-schema ordering exception), `deno task check` (format, lint, typecheck, 16/16 contract, 21/21 transport, and 20/20 lifecycle tests; Phase 4 shutdown correctly skipped), and `git diff --check`; all passed. The executable launcher gate passed, and committed `coverage.json` remained unchanged at SHA-256 `3dd35e449d5b9fffc836c74d17e375a215e689ebbb3018b35473a274b8a8a262`. | One root post-validation review found and fixed three true positives through the same implementer: credential matching rejected non-secret account flags while missing bearer/auth/id token material and prefixed account identifiers; the evidence schema accepted raw account IDs and temporary repository paths; and stable server-request responses were not retained/correlated. Targeted fix verification passed; no additional review pass was run. | None. Phase 3 is complete. Phase 4+ remain unimplemented, and no live authentication, acceptance publication, or shutdown-containment claim was attempted. |
| Phase 4 | `implementer-sol-high` | `deno.json`, `src/diagnostics.ts`, `src/process_host.ts`, `src/process_tree_darwin.ts`, `src/shutdown.ts`, shutdown modes in `tests/fixtures/fake_app_server.ts`, and `tests/shutdown_test.ts` | None (left uncommitted for supervisor) | **Blocked at the absolute containment gate.** Exact temporary Deno `2.9.3` at `/tmp/vantage-deno-2.9.3.WgHO8X/deno`, Codex CLI `0.145.0`, Git `2.50.1`, Darwin arm64. Before review, root independently reran `deno task test:shutdown` (10/10), `deno task protocol:verify` (617 TypeScript and 273 JSON Schema files; only the named aggregate-schema ordering exception), `deno task check` (16/16 contract, 21/21 transport, 20/20 lifecycle, and 10/10 shutdown), and `git diff --check`; all passed. After the time-boxed review fixes, root ran only the requested targeted gate: `deno task test:shutdown` passed 12/12. The real immediate-`setsid` fixture became its own group/session leader, outlived and reparented from the direct child, survived owned-group cleanup, remained in `remainingPids`, and was explicitly removed by the cleanup-safe harness. | One root post-validation review found and fixed three true positives through the same implementer: the nested fixture had a hidden TypeScript return-type error and was absent from the `check` type-check inputs; preparation hooks could wait without a manifest deadline; and setup-failure cleanup used a permission-denied kill path followed by unbounded joins. The corrected targeted shutdown gate passed; no further review or exploration was run. | `TRACKER_UNAVAILABLE` / `CONTAINMENT_UNPROVEN`: this macOS/Deno environment provides no pre-exec, lossless lineage tracker. Snapshot polling, `NOTE_FORK`, and process-group signaling cannot account continuously for immediate `setsid`/reparent escape, while EndpointSecurity/audit-class facilities require unavailable privilege or entitlement. `noObservedDescendantsRemain` remains observational only, `escapedDescendantContainmentProven` remains false, Phase 4 stays incomplete, and Phase 5 remains dependency-blocked. |
| Phase 4 | `implementer-sol-high` | `src/diagnostics.ts`, `src/shutdown.ts`, `schemas/evidence.schema.json`, `tests/shutdown_test.ts`, and focused cleanup-acceptance assertions in `tests/transcript_test.ts` | None (left uncommitted for supervisor) | **Passed on the revised bounded observed-tree gate.** Recovery snapshot `2b58fc5f682786007c90cba2cb435178601b4e0b` was retained as the implementation base. Exact temporary Deno `2.9.3` at `/tmp/vantage-deno-2.9.3.WgHO8X/deno`, Codex CLI `0.145.0`, Git `2.50.1`, Darwin arm64. Root independently reran `deno task test:shutdown` (12/12), `deno task protocol:verify` (617 TypeScript and 273 JSON Schema files; only the named aggregate-schema ordering exception), `deno task check` (format, lint, typecheck, 16/16 contract, 21/21 transport, 20/20 lifecycle, and 12/12 shutdown), and `git diff --check`; all passed. Ordinary graceful, `SIGTERM`, `SIGKILL`, protocol-failure, timeout, unexpected-request, child-exit, and cancellation paths share memoized cleanup evidence with direct status and stdout/stderr drains settled, `remainingPids: []`, and `noObservedDescendantsRemain: true`. | No separate review pass was requested. The implementation agent's targeted schema assertion initially exposed a TypeScript inference error, which it corrected before handoff; the targeted assertion and all repository-wide gates then passed. | None. Snapshot-only operation accurately retains `TRACKER_UNAVAILABLE` / `CONTAINMENT_UNPROVEN` diagnostics and `escapedDescendantContainmentProven: false` without failing an otherwise clean ordinary observed tree. The real immediate-`setsid`/reparent fixture remains a cleanup-safe fatal `DESCENDANT_LEAK` negative test and is never reported as contained. |
| Phase 5 | `implementer-sol-high` | `deno.json`, `src/main.ts`, `src/lifecycle_scenario.ts`, `src/transcript.ts`, and `tests/authenticated_turn_test.ts` | None (left uncommitted for supervisor) | **Passed.** Exact temporary Deno `2.9.3` at `/tmp/vantage-deno-2.9.3.WgHO8X/deno` with its directory prepended to `PATH`, Codex CLI `0.145.0`, Git `2.50.1`, and Darwin arm64. Root independently reran `deno task check` (format, lint, typecheck, 16/16 contract, 21/21 transport, 20/20 lifecycle, and 12/12 shutdown), the explicit `VANTAGE_RUN_AUTHENTICATED_TEST=1 deno task test:authenticated` gate (1/1), `deno task spike:verify`, and `git diff --check`; all required gates passed. The final verify-only run completed one non-empty authenticated agent turn with 37 stdout protocol lines, 289 bounded stderr bytes, 43 retained records, 17 observed coverage entries, direct exit code 0, settled stdout/stderr drains, `remainingPids: []`, `noObservedDescendantsRemain: true`, and accurate non-blocking `escapedDescendantContainmentProven: false`. Required observations were recorded without new performance thresholds. The only committed coverage/evidence path, `coverage.json`, remained byte-identical before and after at SHA-256 `3dd35e449d5b9fffc836c74d17e375a215e689ebbb3018b35473a274b8a8a262`; no committed evidence path was created or modified. | One root integration review found one true positive after diagnosing the first live `DESCENDANT_LEAK`: the Phase 5 recovery used a stale process snapshot before signaling. The same implementer added an immediate per-PID ownership re-read; absent PIDs are treated as naturally exited, while group mismatch, persistent zombies, and final presence remain fail-closed. Formatting/typecheck, the explicit authenticated gate, and `spike:verify` passed after the repair. No additional review pass was run. | None. The first live run exposed a supported, live reparented helper that remained in the owned process group after direct-child exit; the minimal Phase 5 recovery now re-observes and reaps only revalidated owned members within existing manifest bounds. Phase 6 publication remains intentionally out of scope. |
| Phase 6 | `implementer-sol-high` | `deno.json`; `src/coverage.ts`, `src/generate_protocol.ts`, `src/main.ts`, and `src/transcript.ts`; `tests/config_test.ts`, `tests/coverage_test.ts`, and `tests/transcript_test.ts`; run-derived `coverage.json`; and the redacted transcript and cross-hashed summary under `evidence/` | None (recovery snapshot `d82df8b5470e8dc879bd3378985fb658adfca5e7` reused; final recovery changes and proof artifacts left uncommitted for supervisor) | **Passed.** Exact temporary Deno `2.9.3` with its directory prepended to `PATH`, Codex CLI `0.145.0`, Git `2.50.1`, and Darwin arm64. The focused proof-set rejection/interruption test passed. `deno task spike:accept` published and post-publication validated 43 retained records and 17 observed coverage entries with every required gate true. `deno task protocol:verify` verified 617 TypeScript and 273 JSON Schema files with only the named aggregate-schema ordering exception. `deno task check` passed formatting, lint, typecheck, 18/18 contract tests, 21/21 transport tests, 21/21 lifecycle tests, and 12/12 shutdown tests. One final on-disk evaluator pass recalculated matching coverage/transcript/compatibility/generated cross-hashes, revalidated immutable inputs, confirmed `noObservedDescendantsRemain: true`, and retained accurate non-blocking `escapedDescendantContainmentProven: false`. | No separate review pass was requested. The focused recovery fixed only concrete gate failures through the same implementer: raw agent reconstruction now includes the `item/started` seed; segment-aware redaction preserves exact staged reconstruction without exposing text; post-publication protocol verification accepts journal-derived nonzero coverage while retaining an explicit Phase 1 zero-baseline gate; and machine-canonical coverage is excluded only from generic formatting while remaining governed by proof-set canonical-byte validation. | None. Failed intermediate acceptance attempts published nothing and left baseline coverage unchanged; the final proof set is complete, cross-hashed, schema-valid, and intentionally uncommitted for supervisor verification. |
