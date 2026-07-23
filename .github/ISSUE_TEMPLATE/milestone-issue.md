---
name: Milestone issue
about: A scoped slice of work inside a milestone — intent, boundaries, and acceptance criteria, with design delegated to ADRs.
title: ""
labels: enhancement
---

<!--
Ownership rules — what goes where:
- Issue body: intent, premises, scope boundaries, acceptance criteria. Frozen contract; should stay true after the code evolves.
- ADR / design doc: package layout, wire formats, size limits, rationale. Link them — never inline them here.
- Comments: status updates, "this landed early in PR #NN" narrative, anything with a timeline.
- Milestone description: the vertical-level outcome and out-of-scope. Never restate it in an issue.
-->

## Goal

<!-- One or two sentences: what this issue delivers, and which parent issue or ADR defines the contract it implements (link with #NN). The issue implements; the parent defines. -->

## Architecture

<!-- OPTIONAL — delete if orientation isn't needed. Link the milestone map (docs/milestones/) for the vertical-wide view; only draw what THIS issue creates or changes. No file paths, byte limits, or wire formats — link the relevant ADR(s) instead. End with a one-line code pointer at module level. -->

## Premises

<!-- Facts that make the issue interpretable months later:
- Blocking dependencies: "Blocked by #NN: <what it provides>."
- Repo-state assumptions: what exists (or doesn't) before this issue.
- Standing constraints the work must respect (e.g. read-only, intentionally excluded data). -->

## In scope

<!-- Outcome-level bullets: behaviors and boundaries this issue delivers. Prescribe *what* and *boundaries*, not *how*. If a bullet names a file or a number, it probably belongs in an ADR. -->

## Out of scope

<!-- What this issue deliberately excludes. Point each exclusion to where it lives instead: a future issue (#NN), another milestone, or "not scheduled". -->

## Acceptance criteria

<!-- Behavioral and testable. Each bullet must be checkable by a reviewer without interpretation — name the cases tests must cover, the invariants that must hold, and the validation that must stay green. -->
