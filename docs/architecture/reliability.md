# Reliability and validation

Status: **Accepted minimal behavioral boundary for Milestone 1**

Milestone 1 validates the risks that can break its
[session-only user journey](vertical-slice.md). It does not create a standalone hardening,
certification, or reliability platform.

## Invariants

1. The canonical selected Git repository is the working directory for every turn in the session.
2. At most one app-server process and one native thread belong to the open Vantage session.
3. At most one turn is unresolved or active.
4. Assistant text and terminal state are shown in native order.
5. Interruption, failure, and completion remain distinct visible outcomes.
6. Uncertain input is never submitted again automatically.
7. Closing Vantage ends the ephemeral conversation and its owned app-server process.

## Behavioral checks attached to issue #2

The first-turn implementation includes focused deterministic checks for:

- rejecting missing, inaccessible, and non-Git repository paths before Codex starts;
- preventing a second submission while native acceptance or completion is pending;
- preserving assistant-text order through a completed terminal state;
- presenting missing-Codex, initialization, and authentication failures as retryable; and
- ending the owned native process when the window closes during idle or active work.

The packaged demonstration uses a real authenticated Codex installation to answer a question that
requires inspecting the selected repository.

## Behavioral checks attached to issue #6

The same-session conversation implementation includes focused checks for:

- using the same native thread for a context-dependent follow-up;
- preserving prompt, answer, and terminal-state order across sequential turns;
- keeping stop pending until interruption or connection failure is known;
- returning to a usable prompt state after completion, interruption, or retryable failure; and
- never replaying the stopped or uncertain prompt.

The packaged demonstration completes a follow-up, stops another response, and then sends a new
prompt in the same open conversation.

## Process cleanup boundary

Vantage asks the owned app-server process to close and uses the smallest platform mechanism needed
to ensure that process is no longer running after the packaged window closes. The acceptance check
covers both idle and active turns on the primary development platform.

Milestone 1 does not build process-lineage certification, cross-platform descendant containment, an
evidence publisher, or a generalized shutdown framework. A concrete cleanup failure discovered
during the packaged demonstration is fixed inside the affected product issue.

## Deferred reliability work

The following concerns require a later consumer-visible vertical before they become deliverables:

- SQLite, migrations, durable projections, and application event logs;
- saved projects and threads, restart resume, and native reconciliation;
- replay cursors, reconnect windows, queues, coalescing, and backpressure programs;
- persistent approvals and stale-request recovery;
- resource budgets, broad observability, stress programs, and compatibility certification;
- multi-platform process containment and support claims.

Tests for those concerns are not created in Milestone 1.
