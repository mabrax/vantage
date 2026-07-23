# Vantage documentation

The documentation separates product direction from current implementation decisions. This keeps
the long-term idea visible without making every future surface a requirement of the first build.

## Document map

| Document | Question it answers | Change rate |
| --- | --- | --- |
| [Product foundation](FOUNDATION.md) | What should Vantage become, and why? | Low |
| [Architecture overview](architecture/README.md) | How is the current system shaped? | Medium |
| [First vertical slice](architecture/vertical-slice.md) | What are we proving first? | High |
| [Codex app-server integration](architecture/codex-app-server.md) | How does Vantage speak to Codex? | Medium |
| [Reliability and validation](architecture/reliability.md) | How will lifecycle, recovery, and tests work? | Medium |
| [Decision log](architecture/decisions.md) | Which conflicting or uncertain choices were resolved? | Append-only |

## Authority and conflicts

The documents have different jobs rather than a single precedence order:

- The product foundation owns the desired product direction and long-term surfaces.
- The vertical-slice document owns the boundary and acceptance criteria of the current delivery.
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
