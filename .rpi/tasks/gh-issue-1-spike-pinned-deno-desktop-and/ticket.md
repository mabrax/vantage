---
type: ticket
source: github
source_id: "mabrax/vantage#1"
source_url: "https://github.com/mabrax/vantage/issues/1"
source_updated_at: "2026-07-23T00:51:55Z"
---

# Spike pinned Deno Desktop and Codex app-server compatibility

## Source metadata

- Repository: `mabrax/vantage`
- Issue: `#1`
- State: OPEN
- Author: mabrax
- Created: 2026-07-23T00:51:55Z
- Updated: 2026-07-23T00:51:55Z
- Labels: enhancement
- Milestone: Vertical Slice 1 — Codex Chat
- Assignees: none

## Description

## Outcome

Prove the two experimental/runtime boundaries before building product UI.

## Scope

- Select and record an exact Deno 2.9 patch and Codex CLI version.
- Generate TypeScript and JSON Schema artifacts from the pinned Codex CLI.
- Build a Deno test client that launches codex app-server over JSONL stdio.
- Exercise initialize/initialized, account/read, model/list, thread/start, turn/start, streamed output, turn completion, and clean shutdown.
- Record startup, first-event, completion, and shutdown observations plus known platform constraints.

## Acceptance criteria

- [ ] A real authenticated turn completes in a temporary Git repository with a schema-valid ordered transcript.
- [ ] The app-server process and descendants exit cleanly.
- [ ] The pinned compatibility pair and initial method/event coverage manifest are committed.
- [ ] Missing Deno, missing Codex, unsupported version, and unauthenticated states produce actionable errors.

## Dependencies

- None; this is the first executable spike.

## Design references

- docs/architecture/vertical-slice.md
- docs/architecture/README.md
- docs/architecture/codex-app-server.md
- docs/architecture/reliability.md

## Comments

_No comments._
