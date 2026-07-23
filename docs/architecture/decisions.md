# Architecture decision log

This log records decisions that resolve conflicts in earlier notes or constrain the first vertical
slice. New decisions should be appended; superseded decisions should link to their replacements.

## D-001 — Use Deno Desktop instead of Tauri

Date: 2026-07-22

Status: **Accepted**

The original foundation named Tauri as fixed. Vantage will instead use `deno desktop`, introduced in
Deno 2.9. It keeps the web UI and privileged TypeScript host in one toolchain and provides desktop
packaging, local HTTP serving, WebView/CEF backends, and in-process bindings.

Because the feature is currently experimental, Vantage will pin a Deno patch release, validate the
packaged runtime early, and keep Deno Desktop-specific code at the application boundary.

## D-002 — Implement Codex natively before designing provider adapters

Date: 2026-07-22

Status: **Accepted**

The original foundation proposed a common harness adapter shape before any complete integration.
The inspected app-server design shows that Codex has native thread identity, server-initiated
requests, approvals, event types, recovery rules, and versioned schemas that a premature common
model could hide.

The first implementation therefore uses Codex names and semantics. A provider abstraction is
deferred until Codex works end to end and a second provider supplies concrete comparative evidence.

## D-003 — Build the chat slice before files and terminal surfaces

Date: 2026-07-22

Status: **Accepted**

The old build sequence placed the file explorer and terminal before the agent runner. The first
product proof is now project-scoped Codex chat: sidebar, threads, model selection, streamed turns,
blocking interaction, and resume. Files, terminal, tasks, and flow remain product direction, but are
not prerequisites for proving the core conversation.

## D-004 — Use one app-server process per live Vantage thread

Date: 2026-07-22

Status: **Provisional**

Although app-server can host multiple native threads, one child process per live Vantage thread
gives simple ownership, a fixed working directory, approval correlation, and failure isolation.
Processes are created lazily and can be reaped while the native thread remains durable.

This choice should change only if measured startup time or memory becomes a real bottleneck.

## D-005 — Separate desktop commands from streamed events

Date: 2026-07-22

Status: **Provisional**

Deno Desktop bindings are a good typed request/response boundary but do not themselves expose a
host-pushed stream. Vantage will use bindings for commands and snapshots, and a same-origin SSE
route from the desktop `Deno.serve()` handler for ordered events. Sequence IDs provide reconnect
behavior.

The protocol spike must validate this in the packaged WebView. If SSE is unreliable, the replacement
must preserve the same snapshot-plus-sequence contract.

## D-006 — Use local SQLite for Vantage-owned state

Date: 2026-07-22

Status: **Accepted**

Project registration, Vantage/native ID mappings, preferences, and ordered UI projections need
transactional local persistence. Deno supports SQLite through `node:sqlite`, avoiding a service or a
native dependency outside the runtime. Codex history and repository contents remain external
sources of truth.

Because `node:sqlite` is synchronous, one dedicated persistence worker owns the connection and
serializes transactions so database work cannot block app-server stdout ingestion.

## D-007 — Register projects by validated path in the first slice

Date: 2026-07-22

Status: **Provisional**

Deno Desktop does not currently provide a first-class native folder picker. The first slice accepts
a pasted or typed path, canonicalizes it, verifies that it is an accessible Git repository, and then
stores it. This proves sidebar behavior without adding FFI or another desktop framework.

A native picker can replace the input when the runtime adds one or a focused integration is proven.

## D-008 — Keep thread and live session distinct

Date: 2026-07-22

Status: **Accepted**

Earlier notes used session for both historical work and a running harness. Vantage uses **thread**
for the durable conversation, **turn** for one request, and **live session** for the disposable
app-server connection. This matches the required restart behavior and prevents process lifetime from
becoming conversation identity.
