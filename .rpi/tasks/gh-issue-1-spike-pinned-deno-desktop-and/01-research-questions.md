---
type: research-questions
---

# Research Questions

## Context

Vantage is currently documented as a Deno Desktop application whose privileged host communicates with a pinned `codex app-server` process over JSONL stdio. The repository’s architecture documents define a phase-zero protocol spike, while the lightweight scan found no existing implementation, runtime configuration, or test harness to assume as a starting point.

## Questions

1. What executable code, runtime configuration, version-pinning files, generated artifacts, test infrastructure, and repository conventions currently exist for this spike, and how do the relevant requirements divide across `docs/architecture/README.md`, `docs/architecture/vertical-slice.md`, `docs/architecture/codex-app-server.md`, and `docs/architecture/reliability.md`? Provide file-and-line evidence, including evidence for material absences.
2. What version-reporting, release, installation, and compatibility information do the current Deno and Codex CLI interfaces expose for identifying an exact Deno 2.9 patch and Codex CLI compatibility pair, and what platform or experimental-runtime constraints apply? Cite primary Deno and OpenAI sources alongside any repository evidence.
3. What commands and output contracts does the pinned Codex CLI expose for generating TypeScript definitions and JSON Schema artifacts, and how do those artifacts identify protocol methods, notifications, payload unions, and version-specific compatibility behavior? Cite the generated-schema interfaces or other primary OpenAI sources and connect them to `docs/architecture/codex-app-server.md`.
4. What is the exact app-server wire sequence and data contract for process startup, `initialize`, `initialized`, `account/read`, `model/list`, `thread/start`, `turn/start`, streamed item or progress output, and `turn/completed`, including request IDs, native thread/turn IDs, stdout-versus-stderr handling, and ordering guarantees? Support the answer with pinned-schema evidence, primary OpenAI documentation, and repository file-and-line references.
5. Which concrete events and payloads can occur during one real authenticated text turn with the pinned CLI, and what evidence is needed to classify them in the initial method/event coverage manifest and prove that a captured transcript is ordered and schema-valid? Distinguish required lifecycle evidence from optional or unknown notifications.
6. How do the relevant Deno subprocess APIs behave for spawning `codex app-server` without a shell, streaming and closing stdio, observing exit status, applying time bounds, and terminating descendant processes on each initially relevant operating system? Cite primary Deno documentation and relate the findings to the shutdown and no-descendant invariants in `docs/architecture/reliability.md`.
7. What observable conditions distinguish missing Deno, missing Codex, an unsupported Codex version, and an unauthenticated Codex profile, and what existing test and diagnostics expectations govern actionable error output, temporary Git repositories, authenticated-test isolation, timing observations, and clean-shutdown verification? Provide file-and-line evidence for local expectations and primary-source evidence for external behavior.
