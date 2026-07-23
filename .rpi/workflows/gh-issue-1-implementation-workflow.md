# RPI Implementation Workflow State: GitHub Issue #1

- Repository: `mabrax/vantage`
- Issue: `mabrax/vantage#1`
- Plan: `.rpi/tasks/gh-issue-1-spike-pinned-deno-desktop-and/08-plan.md`
- Structure outline: `.rpi/tasks/gh-issue-1-spike-pinned-deno-desktop-and/07-structure-outline.md`
- Task branch: `rpi/gh-issue-1-spike-pinned-deno-desktop-and`
- Supervisor status: `running`
- Current phase: `5`
- Last updated: `2026-07-23T17:47:32-04:00`

| Phase | Status | Codex task | Checkpoint commit | Notes |
|---|---|---|---|---|
| 1 | `completed` | initial `019f8fea-c453-7e10-afd0-42df3552bf4a`; correction `019f8ff3-471a-7832-8f41-d9ddf46e35d1`; retry `019f8ffc-855a-7361-bdec-edc9b8bcc04f` | `fa4144f49ff816a31d18fe0a4ea1b5a1b1661f1a` | All Phase 1 gates passed; 16/16 contract tests |
| 2 | `completed` | `019f901b-6f54-7782-acf5-87344acb8bf4` | `7dde1239a0faa8ea1501d5f011083a5dc492eaa5` | Bounded bidirectional JSONL transport; 21/21 tests |
| 3 | `completed` | `019f903b-ef57-7eb0-9093-4847309163c5` | `2be6613ed72c9c1d494c471ed888817710d25a80` | Offline lifecycle/evidence gate; 20/20 tests |
| 4 | `completed` | initial `019f9067-dad2-79a3-9c27-5f094145c94a`; plan correction `019f90d5-c594-7d73-89ec-61bb4fd92ce2`; retry `019f90e6-a4a4-7343-9cd8-d79b1213c1aa` | `5d7810ac87f97dae29841ecb7fc464849ad798ae` | Revised gate passed: 12/12 shutdown tests, empty remaining PIDs, settled direct status and drains; immediate `setsid` remains a documented fail-closed limitation |
| 5 | `pending` | — | — | Requires completed Phase 4 |
| 6 | `pending` | — | — | Requires completed Phases 4 and 5 |

## Superseded Blocker

The unprivileged Darwin/Deno host has no available race-closing, loss-detecting
descendant-lineage facility. The real immediate-`setsid` fixture reparents and
survives ordinary process-group cleanup. The implementation correctly reports
`TRACKER_UNAVAILABLE`, `CONTAINMENT_UNPROVEN`, and a descendant leak while
keeping `escapedDescendantContainmentProven: false`. EndpointSecurity or
audit-class tracking would require capabilities or entitlements not available
to this process.

The user selected Option 1 on 2026-07-23: MVP acceptance now requires bounded
clean shutdown of the actual observed pinned-Codex process tree. The
`escapedDescendantContainmentProven` field remains required evidence and must
stay false unless independently proven, but false no longer blocks the MVP.
The immediate-`setsid` case remains an unsupported, fail-closed negative test.

## Resume Instructions

Read this file and the plan Run Ledger. Resume from the first phase not marked
`completed`. Every phase must run in a fresh Codex task using
`rpi:implement-plan`, with the explicit plan path, structure-outline path,
phase number, and task branch. Verify and checkpoint a completed phase before
starting its dependents.
