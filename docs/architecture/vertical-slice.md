# First vertical slice: Codex chat

Status: **Accepted delivery boundary**

## Outcome

The first vertical slice proves that Vantage can be the place where a developer opens a local Git
project and has a real, resumable Codex conversation.

At the end of the slice, a user can register a project in the sidebar, create or reopen a thread,
choose an available Codex model, send a prompt, watch the answer and agent activity stream, respond
when Codex blocks for input, interrupt a running turn, restart Vantage, and continue the thread.

This is a product slice, not just a protocol demo. It crosses the desktop shell, UI, persistence,
Codex process lifecycle, and recovery path.

## Primary user journey

1. Launch Vantage as a Deno Desktop application.
2. See whether the local Codex CLI is supported and authenticated.
3. Register a local Git repository by entering or pasting its path.
4. Select the project from the sidebar.
5. See its existing Vantage threads or create a new one.
6. Choose a model and, where supported, a reasoning effort and runtime mode.
7. Send a text prompt.
8. See user text, streamed assistant text, turn state, and tool activity in order.
9. Respond to an approval or structured user-input request if the turn produces one.
10. Interrupt the turn if needed.
11. Close and reopen the app, open the thread, and continue the native Codex conversation.

## In scope

### Desktop shell and project sidebar

- package and launch through a pinned Deno Desktop version;
- display registered projects in a persistent sidebar;
- register a path only after canonicalizing it and verifying that it is an accessible Git
  repository;
- select one active project; and
- remove a project from Vantage without deleting its repository.

The first slice does not depend on a native folder picker because Deno Desktop does not currently
provide one as a first-class API.

### Codex preflight and controls

- discover a configured Codex executable;
- reject unsupported Codex CLI versions with an actionable message;
- read account/authentication state through app-server;
- obtain the selectable model catalog from `model/list`;
- persist the chosen model as the Vantage thread default;
- show reasoning effort only when the selected model/schema supports it; and
- expose a small set of named runtime modes rather than raw Codex flags.

The app relies on the user's existing Codex CLI login. It does not implement OpenAI authentication.

### Threads and chat

- list Vantage threads for the selected project;
- create a Vantage thread and native Codex thread;
- lazily resume an existing native thread;
- render the native thread history needed for continuity;
- send one text turn at a time;
- stream assistant text and ordered activity;
- show running, completed, interrupted, failed, and recovery-needed states;
- interrupt the active turn;
- surface command, file-change, MCP, plan, error, and usage activity at least in a truthful generic
  activity row when a richer renderer does not yet exist; and
- prevent duplicate submission while send state is uncertain.

### Blocking interaction

- show command and file-change approval requests with their relevant details;
- approve, deny, or cancel exactly once;
- show structured user-input requests and return the user's answer;
- mark requests stale if their owning process exits; and
- make it impossible for a late UI response to settle a different request.

### Persistence and recovery

- persist registered projects, Vantage thread metadata, native Codex IDs, selected controls, and the
  UI projection;
- load historical threads without eagerly starting child processes;
- resume when the user opens or sends to a stopped thread;
- reconcile the projection with `thread/read` after restart or uncertain process exit; and
- never resend an uncertain turn automatically.

## Explicitly out of scope

- providers other than Codex;
- a generic harness/provider adapter API;
- project file browsing or editing as a standalone UI;
- embedded terminals or PTYs;
- task lists, Kanban, epics, or the flow view;
- multiple simultaneous active turns in one thread;
- automatic steering of a second prompt into a running turn;
- thread fork, rollback, or archive UI;
- image and file attachments;
- application-specific MCP tools;
- multi-agent handoffs;
- cross-device synchronization; and
- production auto-update or installer polish beyond what is needed to validate the packaged app.

These remain possible follow-on slices. They must not shape a speculative framework around the chat
implementation.

## Interaction contract

### Project selection

Changing the selected project changes the visible thread list and the working-directory context for
new or resumed Codex processes. A thread cannot silently move between projects.

### Model selection

The model selector is populated from Codex rather than a hard-coded list. The chosen value is stored
with the Vantage thread and sent through the supported native request field. A model change applies
only when no turn is active and must be visible before the next prompt is submitted.

### Turn state

Only one turn may be active per thread. Sending is disabled while submission is unresolved. Stop
maps to native interruption and remains visibly pending until Codex confirms completion or the
connection fails.

### Activity presentation

The UI may begin with compact activity rows, but it cannot reduce all native activity to assistant
text. At minimum, users can distinguish thinking/progress, tool execution, file change, approval,
user input, error, and turn completion.

### Restart and resume

The sidebar and thread list render from Vantage state without launching Codex. Opening a thread
starts a process only when native data or a new turn is needed. If native resume fails, the app shows
the reason and never silently starts a replacement thread.

## Acceptance scenarios

The slice is complete only when these scenarios pass through the packaged Deno Desktop app:

1. **First conversation** — register a temporary Git repository, select a catalog model, create a
   thread, send a prompt, observe streamed text, and reach a completed turn.
2. **Restart and continue** — quit Vantage after a completed turn, relaunch it, reopen the thread,
   ask a follow-up that depends on prior context, and confirm the same native Codex thread ID is used.
3. **Interruption** — stop a running turn and reach a truthful terminal state without an orphaned
   app-server process or an automatically repeated prompt.
4. **Blocking request** — exercise at least one native approval or user-input request end to end and
   reject a duplicate or stale response.
5. **Model control** — show models returned by the pinned Codex CLI, persist a selection, and prove
   that the selected model is used for the turn.
6. **UI reconnect** — reconnect the event stream and recover from the last application sequence
   without missing or duplicating visible activity.
7. **Unsupported environment** — show useful states for missing Codex, unsupported CLI version,
   unauthenticated account, missing repository, and unavailable native thread.

## Build order

1. **Protocol spike** — prove Deno can launch the pinned app-server, complete initialization and one
   streamed turn, and terminate it cleanly.
2. **Desktop skeleton** — package a minimal Deno Desktop window, typed binding, local SSE stream, and
   SQLite database.
3. **Project and catalog path** — add the sidebar, validated project registration, account preflight,
   and model catalog.
4. **Thread path** — create, list, open, start, and resume threads with durable ID mapping.
5. **Turn path** — send text, project ordered notifications, render activity, interrupt, and complete.
6. **Blocking requests** — add approval and structured user-input responses.
7. **Recovery path** — add restart, reconciliation, stale-request behavior, and packaged acceptance
   tests.

Each step should leave an end-to-end path working; protocol behavior should not be replaced with
mocked UI assumptions after the initial spike.

## Evidence produced for the next slice

The completed slice should leave behind:

- a pinned Deno Desktop and Codex CLI compatibility pair;
- a native method and event coverage manifest;
- measured startup, resume, first-event, and shutdown behavior;
- a record of WebView and platform limitations encountered;
- real examples of projection and recovery behavior; and
- a prioritized next-slice choice grounded in use rather than the original feature list.
