# First vertical slice: session-only Codex chat

Status: **Accepted interaction contract for Milestone 1**

The [GitHub milestone](https://github.com/mabrax/vantage/milestone/1) owns the product outcome and
vertical-level exclusions. The [milestone map](../milestones/01-codex-chat.md) owns issue
sequencing and invariants. This document defines how the in-scope conversation behaves.

## Primary user journey

1. Launch the packaged Vantage application on the primary development platform.
2. Paste or type the path to one local Git repository.
3. See an actionable state if the path is invalid or Codex is unavailable or unauthenticated.
4. Start a session using the user's existing Codex defaults and fixed read-only access.
5. Ask a question whose answer requires inspecting the selected repository.
6. See the prompt, streamed assistant text, and a truthful terminal state.
7. Ask a context-dependent follow-up in the same native conversation.
8. Stop a response that is no longer useful and return to a usable prompt state.
9. Close Vantage, ending the ephemeral conversation and its app-server process.

## In-scope behavior

### Repository selection

- Accept one typed or pasted local path before the conversation begins.
- Canonicalize the path and verify it is an accessible Git repository.
- Start no Codex process for an invalid path.
- Keep the selected repository fixed after the native conversation begins.

There is no saved registry or sidebar. A new app session may select a different repository.

### Codex readiness

- Use a locally available Codex CLI and its existing authentication.
- Use the existing default model rather than loading a catalog or presenting selectors.
- Show a concise, retryable state when Codex is missing, cannot initialize, or requires
  authentication.
- Keep authentication outside Vantage.

### First answer

- Start one native Codex thread scoped to the selected repository.
- Submit one text prompt with fixed read-only access.
- Render the user's prompt and assistant text as it arrives.
- Show running, completed, interrupted, and failed states without inferring success from partial
  text.
- Prevent another submission while native acceptance is unresolved or the turn is active.

### Same-session conversation

- Reuse the same native thread for sequential prompts while Vantage remains open.
- Preserve the visible chronological order of prompts, answers, and terminal states.
- Re-enable prompt submission after completion, interruption, or a retryable failure.
- Let the user stop an active response and keep interruption pending until Codex reports a terminal
  state or the connection fails.
- Never automatically resubmit uncertain user input.

### Session end

- Treat the repository selection, transcript, and native thread as in-memory session state.
- Terminate the Vantage-owned app-server process when the window closes.
- Begin the next launch without implying that the prior conversation was saved or resumed.

## Interaction contract

### Repository truth

The canonical selected repository is the native working directory for every turn in the session. UI
text cannot change that boundary, and invalid aliases or sibling paths do not authorize a different
repository.

### Prompt truth

The UI distinguishes text entered by the user, native acceptance of a turn, streamed output, and the
terminal outcome. The send control remains unavailable until starting another turn is safe.

### Transcript truth

Visible user prompts and assistant text remain in native order. Milestone 1 does not require rich
tool, plan, diff, usage, approval, or file-change renderers; ignored native activity must not be
presented as fabricated assistant prose.

### Interruption truth

Stop is a request, not an immediate success state. The UI stays pending until interruption,
completion, or connection failure is known. After the terminal state, the same open conversation
may accept another prompt.

### Failure and retry

Repository validation and Codex readiness failures are actionable and retryable. A failed or
uncertain turn is never reported as completed or replayed automatically.

## Explicitly out of scope

- saved projects, a project sidebar, and multiple repositories;
- saved threads, thread lists, restart/resume, and reconciliation;
- SQLite, migrations, durable projections, replay cursors, and a generalized event log;
- model, reasoning, profile, and runtime-mode selectors;
- approvals, structured input, write-enabled work, and persistent policies;
- rich tool activity, file-change views, attachments, and application-specific MCP tools;
- embedded files, terminals, tasks, plans, and flow surfaces;
- concurrent turns, prompt queues, steering, fork, rollback, archive, and handoff;
- providers other than Codex and provider abstractions;
- generated full-protocol artifacts, compatibility ranges, coverage certification, evidence
  publishing, stress programs, and broad observability;
- multi-platform support claims, installers, auto-update, and release polish.

These exclusions are future verticals or not scheduled. They do not shape frameworks inside this
slice.

## Acceptance scenarios

1. **Repository-grounded answer** — in the packaged app, select a temporary Git repository, ask a
   question that requires inspecting it, watch assistant text stream, and reach a visible completed
   state from a real authenticated Codex turn.
2. **Contextual follow-up** — ask a second question that depends on the first exchange and confirm
   the answer continues the same native conversation.
3. **Interruption and reuse** — stop an active response, reach a truthful terminal state, and send
   another prompt in the same open conversation.
4. **Actionable prerequisites** — reject invalid and non-Git paths without launching Codex, and show
   retryable missing-Codex and authentication-required states.
5. **Session cleanup** — close the packaged app during idle and active work without leaving a
   Vantage-owned app-server process running.

Focused behavioral checks protect these scenarios. Tests are not separate milestone deliverables.

## Delivery order

1. [Issue #2](https://github.com/mabrax/vantage/issues/2) delivers the packaged repository selection
   and first real streamed answer.
2. [Issue #6](https://github.com/mabrax/vantage/issues/6) adds same-session follow-up and stop.

Each issue ends in a user-visible packaged demonstration.

## Budget and kill criterion

The complete vertical is capped at five focused implementation days. If a packaged app cannot
complete one real, read-only, repository-scoped Codex turn by the end of day two, stop and
re-evaluate the desktop/runtime path rather than adding infrastructure or proof machinery.
