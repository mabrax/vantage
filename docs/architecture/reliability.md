# Reliability and validation

Status: **Accepted behavioral boundary through the Milestone 3 foundation**

Milestone 1 validates the risks that can break its
[session-only user journey](vertical-slice.md). It does not create a standalone
hardening, certification, or reliability platform.

## Invariants

1. The canonical selected Git repository is the working directory for every turn
   in the session.
2. At most one app-server process and one native thread are live even when
   several durable conversations are registered.
3. At most one live/native turn exists globally because only the selected
   project owns a live process. Each durable conversation has at most one
   unresolved turn; multiple projects may retain recovered unresolved, read-only
   history concurrently.
4. Assistant text and terminal state are shown in native order.
5. Interruption, failure, and completion remain distinct visible outcomes.
6. Uncertain input is never submitted again automatically.
7. Closing Vantage always ends its owned app-server process; the Milestone 1
   ephemeral thread is discarded, while a mapped Milestone 3 native thread
   remains durable.
8. One serialized persistence worker owns the local SQLite connection.
9. Durable native identity is resumed exactly; saved transcript display never
   impersonates context.
10. Uncertain prompts are not replayed and unresolved turns are not promoted to
    completion.
11. Ordered source cannot duplicate, reorder, or cross project identity.
12. Corrupt or incompatible storage is preserved rather than silently replaced.

## Behavioral checks attached to issue #2

The first-turn implementation includes focused deterministic checks for:

- rejecting missing, inaccessible, and non-Git repository paths before Codex
  starts;
- preventing a second submission while native acceptance or completion is
  pending;
- preserving assistant-text order through a completed terminal state;
- presenting missing-Codex, initialization, and authentication failures as
  retryable; and
- ending the owned native process when the window closes during idle or active
  work.

The packaged demonstration uses a real authenticated Codex installation to
answer a question that requires inspecting the selected repository.

## Behavioral checks attached to issue #6

The same-session conversation implementation includes focused checks for:

- using the same native thread for a context-dependent follow-up;
- preserving prompt, answer, and terminal-state order across sequential turns;
- keeping stop pending until interruption or connection failure is known;
- returning to a usable prompt state after completion, interruption, or
  retryable failure; and
- never replaying the stopped or uncertain prompt.

The packaged demonstration completes a follow-up, stops another response, and
then sends a new prompt in the same open conversation.

## Process cleanup boundary

Vantage asks the owned app-server process to close and uses the smallest
platform mechanism needed to ensure that process is no longer running after the
packaged window closes. The acceptance check covers both idle and active turns
on the primary development platform.

Milestone 1 does not build process-lineage certification, cross-platform
descendant containment, an evidence publisher, or a generalized shutdown
framework. A concrete cleanup failure discovered during the packaged
demonstration is fixed inside the affected product issue.

## Behavioral checks attached to issue #25

The durable foundation includes focused checks for:

- fresh database creation, reopen, and exact literal
  prompt/raw-source/native/terminal round trips;
- deterministic forward migration and rollback without half-created records;
- exclusive serialized connection ownership;
- unsupported schema and corrupt-database failures that preserve recoverable
  bytes;
- exact next-sequence source appends and rejection of duplicate, reordered, and
  cross-project data;
- pending, accepted, streaming, completed, interrupted, and failed
  reconciliation after clean close and simulated crash;
- removal that forgets only Vantage state followed by a fresh re-add; and
- a real authenticated two-process native resume with the same thread ID and
  context-dependent follow-up under the fixed read-only policy.

Reconciliation annotates unresolved phases rather than fabricating a terminal
outcome. Exact rules live in
[saved projects and conversations](saved-conversations.md).

## Behavioral checks attached to issue #26

The saved-project registry includes focused checks for:

- rejecting blank, missing, non-Git, duplicate, nested, relative, and symlink
  aliases before another Codex process launches;
- restoring registration order and selected-project preference after reopen;
- keeping missing, moved, inaccessible, identity-changed, and no-longer-Git
  registrations visible at their original canonical identity;
- refusing idle-only selection changes during a live turn and rejecting late
  events from a replaced project session;
- requiring explicit removal confirmation and reaping only the exact selected
  Vantage-owned process before metadata deletion;
- preserving repository sentinels and Git state across cancellation, selected
  and non-selected removal, and repeated commands; and
- giving a re-added canonical root fresh Vantage project/conversation IDs
  without restoring removed Vantage metadata or claiming Codex history deletion.

## Deferred reliability work

The following concerns require a later consumer-visible vertical before they
become deliverables:

- a generalized application event log beyond the accepted conversation
  projection;
- automatic repair or reconstruction of incomplete native history;
- replay cursors, reconnect windows, queues, coalescing, and backpressure
  programs;
- persistent approvals and stale-request recovery;
- resource budgets, broad observability, stress programs, and compatibility
  certification;
- multi-platform process containment and support claims.

Those concerns are not implied by the issue #25 foundation tests.
