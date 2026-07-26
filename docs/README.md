# Vantage documentation

The documentation separates product direction from current implementation decisions. This keeps
the long-term idea visible without making every future surface a requirement of the first build.

## Document map

| Document | Question it answers | Change rate |
| --- | --- | --- |
| [Product foundation](FOUNDATION.md) | What should Vantage become, and why? | Low |
| [Architecture overview](architecture/README.md) | How is the current system shaped? | Medium |
| [Rich response rendering](architecture/rich-response-rendering.md) | How does untrusted streamed Markdown become inert DOM? | Medium |
| [Saved projects and conversations](architecture/saved-conversations.md) | How are durable identity, storage, native resume, and recovery constrained? | Medium |
| [Milestone 1 map](milestones/01-codex-chat.md) | What is in the first product vertical and how is it sequenced? | High |
| [Milestone 2 map](milestones/02-rich-markdown.md) | How does the transcript become a safe rich-response surface? | High |
| [Milestone 3 map](milestones/03-saved-projects-and-conversations.md) | How do saved projects and one conversation per project ship? | High |
| [First vertical slice](architecture/vertical-slice.md) | How should the session-only conversation behave? | High |
| [Codex app-server integration](architecture/codex-app-server.md) | Which native start, turn, interrupt, durable-resume, and cleanup capabilities are accepted? | Medium |
| [Reliability and validation](architecture/reliability.md) | Which behavioral invariants and evidence protect the delivered slices? | Medium |
| [Decision log](architecture/decisions.md) | Which conflicting or uncertain choices were resolved? | Append-only |

## Authority and conflicts

The documents have different jobs rather than a single precedence order:

- The product foundation owns the desired product direction and long-term surfaces.
- The GitHub milestone owns the current delivery outcome and vertical-level exclusions.
- The milestone map owns the vertical-wide view, sequencing, and invariants.
- The vertical-slice document owns the current user journey and interaction contract.
- The architecture documents own current technical implementation decisions.
- The decision log explains why an older statement was superseded or why a provisional choice was
  made.

If product direction and implementation mechanics appear to conflict, preserve the direction and
update the architecture. If the current delivery is smaller than the foundation, that is deliberate
scope rather than a contradiction. Unresolved conflicts belong in the decision log, not in silently
divergent documents.

## Status vocabulary

- **Direction**: a durable product intention, not necessarily scheduled.
- **Accepted**: the current implementation decision.
- **Provisional**: the working decision that must be validated during the vertical slice.
- **Deferred**: desired or possible, but explicitly outside the current slice.
- **Superseded**: retained only in history and no longer guides implementation.
