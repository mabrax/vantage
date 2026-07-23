# Reliability and validation

Status: **Required design for the first vertical slice**

This document covers persistence, ordering, recovery, observability, and tests for the architecture
described in [Architecture overview](README.md) and
[Codex app-server integration](codex-app-server.md).

## Reliability invariants

The implementation must preserve these rules:

1. A Vantage thread has at most one live app-server process.
2. A Vantage thread has at most one active turn.
3. The native Codex thread ID, not projected messages, is the resume identity.
4. Protocol stdout is read continuously and never waits on SQLite or the WebView.
5. Native notifications are projected in wire order.
6. Every UI event has a monotonic application sequence.
7. A server-request response is accepted at most once on its owning connection.
8. An uncertain turn is never automatically replayed.
9. Closing or reaping a process does not delete durable thread identity.
10. Application shutdown leaves no app-server descendants behind.

## Durable records

The initial SQLite schema needs the following logical records. Exact SQL belongs in migrations, not
in this design document.

### Projects

```text
project_id
canonical_path
display_name
created_at
updated_at
last_opened_at
```

The canonical path is unique. Removing a project deletes only Vantage registration and explicitly
defined dependent UI state; it never deletes the repository.

### Threads

```text
app_thread_id
project_id
codex_thread_id
profile_id
model
reasoning_effort
runtime_mode
status
last_sequence
last_seen_at
last_error
created_at
updated_at
```

`codex_thread_id` may be null only before native creation succeeds. A failed create must not be shown
as a resumable native thread.

### Turns

```text
app_turn_id
app_thread_id
codex_turn_id
status
submitted_text
started_at
completed_at
token_usage_json
last_error
```

Persisting user intent before `turn/start` helps explain uncertain submission, but it is not proof
that Codex accepted the turn.

### Projection and event log

Persist enough ordered state to rebuild the UI:

- user and assistant messages;
- compacted assistant segments;
- tool, file-change, MCP, and other activity;
- turn lifecycle and errors;
- completed approval and user-input records;
- plan, diff, routing, and usage state needed by the product; and
- a monotonic application sequence for every emitted change.

Native IDs are stored where available for deduplication and reconciliation. Raw protocol payloads
are not retained by default.

## Ordered ingestion and backpressure

The stdout reader parses bounded lines and enqueues validated messages into a bounded per-session
queue. It performs no SQLite writes and waits on no UI consumer.

A single ordered consumer:

1. applies the message to in-memory session state;
2. sends the durable projection transaction to the dedicated SQLite worker and awaits its result;
3. assigns the application sequence; and
4. publishes the application event to connected UI subscribers.

The consumer may wait for durability, but the stdout reader continues filling the bounded queue on
the host event loop while synchronous SQLite work runs in its worker.

When the queue approaches its limit:

- preserve lifecycle, blocking request, error, and completion messages;
- coalesce high-frequency text or progress deltas only when the final projected result is identical;
- record queue depth and coalescing metrics; and
- fail the live session rather than silently dropping a non-coalescible message.

All writes to child stdin pass through one serialized writer so request and response lines cannot
interleave.

## UI snapshot and event recovery

The UI receives a thread snapshot with the last included application sequence, then opens the SSE
stream after that sequence.

The host retains enough recent events to bridge ordinary UI reconnects. On reconnect:

- if all later events remain available, replay them in sequence;
- if the requested sequence is too old or unknown, tell the UI to fetch a replacement snapshot;
- deduplicate by sequence in the UI reducer; and
- never infer a successful turn merely because the UI previously rendered partial output.

The projection and event stream are application contracts. Protocol request IDs and raw Codex
notifications never become public reconnection cursors.

## Recovery behavior

### Application restart

Load projects, thread metadata, and projections without launching app-server processes. Start a
process only when the user opens a thread that needs native reconciliation or submits a turn.

For the currently opened thread:

1. launch and initialize app-server;
2. call `thread/resume` with the stored native ID;
3. call `thread/read` with turns when reconciliation is required;
4. compare native turn and item IDs with the projection; and
5. persist corrections before publishing a ready snapshot.

### Idle process exit

Mark the live session stopped, expire connection-owned requests, keep the native thread ID, and
lazily resume on the next use.

### Process exit during a turn

1. Fail pending protocol calls and expire pending server requests.
2. Mark the Vantage turn `unknown` or `interrupted`, never successful by inference.
3. Preserve the native thread ID and all confirmed projection state.
4. Require an explicit reopen or retry action to start another process.
5. Resume and use `thread/read` to discover the final native state.
6. Never automatically resend the user's text.

If native state proves the turn completed, reconciliation may replace `unknown` with the native
terminal state. If proof is unavailable, uncertainty remains visible.

### Resume failure

Classify at least:

- native thread missing or unavailable;
- incompatible profile or `CODEX_HOME`;
- unsupported Codex version;
- authentication required;
- malformed or incompatible protocol;
- required MCP configuration failure; and
- missing or inaccessible project working directory.

Starting a fresh native thread is an explicit user action. Silent fallback can split conversation
history and is forbidden.

### UI disconnect

The turn continues in the Deno host while the window exists. The UI reconnects from its last
application sequence. If the entire desktop process exits, recovery follows the application restart
path; Vantage does not claim background durability beyond its process.

## Shutdown

Desktop shutdown must:

1. stop accepting new commands;
2. notify the UI that shutdown has begun when time permits;
3. settle or expire local pending operations;
4. request interruption of active turns within a bounded grace period;
5. close stdin and terminate every app-server process tree;
6. wait for process exit within a second bounded period;
7. force termination when graceful cleanup fails; and
8. close SQLite only after projection work is flushed or marked uncertain.

Deno Desktop window close and runtime exit behavior must be tested in the packaged app, not assumed
from development mode.

## Safety and resource limits

The implementation defines and tests bounds for:

- prompt and future attachment size;
- JSONL line size;
- queue length and retained delta bytes;
- number of live processes;
- idle process lifetime;
- pending request count and lifetime;
- SSE client count and replay window; and
- redacted diagnostic history.

Paths are canonicalized before authorization checks. A registered project path is not permission to
operate on arbitrary sibling paths. Symlink and case-normalization behavior must be covered on each
supported filesystem.

## Observability

Every operation should carry, where known:

- Vantage project, thread, and turn IDs;
- native Codex thread and turn IDs;
- profile ID and Codex version;
- Deno version and desktop rendering backend;
- process ID;
- protocol method and request ID;
- session and turn state transition; and
- queue depth and processing latency.

Required measurements include:

- desktop and app-server startup duration;
- initialization, thread start, and resume duration;
- time to first turn event and completion;
- approval wait duration;
- process exits by code and lifecycle phase;
- resume and reconciliation outcomes;
- protocol decode failures by method;
- queue high-water mark, coalescing, and overflow;
- SSE reconnect and snapshot replacement counts; and
- active, idle, and leaked process counts.

Protocol payload logging is off by default. Development diagnostics are bounded, schema-aware,
redacted, and separate from normal logs.

## Test strategy

### 1. Deterministic protocol tests

Use a fake app-server child process over real stdin/stdout. Cover:

- JSONL framing and partial reads;
- request correlation and serialized writes;
- notification ordering;
- server requests and duplicate responses;
- malformed responses and notifications;
- line and queue limits;
- abrupt exit; and
- unknown-notification compatibility.

Assertions target state and messages, not sleeps or log text.

### 2. Real Codex integration tests

Run a pinned CLI in temporary Git repositories and isolated `CODEX_HOME` directories. Cover:

- initialization, account, and model discovery;
- thread start, turn start, streaming, and completion;
- process kill followed by resume and read;
- interruption;
- at least one blocking request flow;
- model and reasoning selection; and
- version rejection or compatibility behavior.

Tests that require an authenticated network account must be explicitly tagged and separated from
deterministic local CI tests.

### 3. Deno Desktop integration tests

Validate the host runtime independently of the WebView:

- typed binding registration and validation;
- persistence-worker startup, SQLite migrations, transactions, and failure propagation;
- SSE ordering, reconnect, and replay-window replacement;
- project path canonicalization; and
- window-close shutdown orchestration.

### 4. Packaged end-to-end tests

Exercise the acceptance scenarios from the [vertical slice](vertical-slice.md) through an actual
packaged application. At least the primary development platform must pass before the slice is called
complete. Other platforms require process-tree, WebView, path, and packaging validation before they
are advertised as supported.

## Validation phases

### Phase 0 — protocol spike

Prove Deno subprocess launch, initialization, account and model reads, one thread, one streamed turn,
and clean shutdown. Capture a schema-valid ordered transcript.

Exit criterion: a Deno CLI harness completes a real turn and leaves no child process.

### Phase 1 — desktop and persistence spike

Prove packaged Deno Desktop, the system WebView, typed bindings, local SSE, SQLite, project access,
and child-process shutdown.

Exit criterion: the packaged app streams deterministic fake-server activity, restarts, and restores
its thread projection.

### Phase 2 — native lifecycle

Prove Vantage/native ID mapping, lazy process creation, native thread start/resume/read, model
control, turn interruption, and reconciliation after a killed process.

Exit criterion: an automated test continues the same native thread after process and application
restart without duplicating a turn.

### Phase 3 — rich blocking interaction

Prove command and file-change approvals, structured user input, tool/file activity, stale response
rejection, and request expiry on process exit.

Exit criterion: every user-blocking request enabled in the slice has an end-to-end UI path and a
deterministic protocol test.

### Phase 4 — reconnect and stress

Prove UI reconnect, process concurrency limits, long output, slow SQLite, slow UI consumption,
malformed JSON, unknown notifications, abrupt exits, and repeated open/close cycles.

Exit criterion: agreed latency and resource budgets pass with no silent event loss or leaked
processes.

## Abstraction gate

A generic provider layer may be proposed only after:

- the vertical-slice acceptance scenarios pass;
- native command and event coverage is documented;
- recovery and approval semantics are stable;
- the UI has exercised the Codex design through real work;
- a second provider has been investigated deeply enough to compare concrete behavior;
- shared concepts and irreducible differences are listed with examples; and
- the proposed seam can preserve useful Codex capabilities without leaking accidental names.

The likely comparison area is commands, capability discovery, and an ordered runtime-event stream.
That is a hypothesis, not an interface commitment.

## Questions the spikes must close

- Which exact Deno 2.9 patch and Codex CLI version form the first compatibility pair?
- Is the system WebView sufficient on every initially supported platform, or is CEF required?
- Does bindings-plus-SSE behave correctly in the packaged app under rapid deltas and reconnect?
- Can Deno reliably terminate Codex descendant processes on each target OS?
- What queue, replay-window, process-count, and idle-timeout limits fit measured behavior?
- Which stable native activity types need custom UI for the first slice?
- Can all required approval and user-input flows be tested without enabling experimental APIs?
