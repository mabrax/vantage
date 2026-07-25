# Vantage

Vantage is a local, Codex-first desktop workspace for software development. Its
first packaged vertical lets a developer point a Deno Desktop application at one
local Git repository, ask their existing Codex installation one read-only
question, and watch the real answer stream to completion.

## Run the first vertical

Prerequisites:

- macOS on Apple silicon (the primary development platform for Milestone 1);
- Deno `2.9.3`; and
- a locally installed and authenticated `codex` CLI available on `PATH`.

```sh
deno task dev
```

Paste a Git repository path, wait for native readiness, and ask one question.
Vantage deliberately does not implement follow-up turns, interruption,
persistence, model controls, approvals, or write-enabled work in this issue.

Build the packaged application and run all repository checks with:

```sh
deno task package
deno task check
```

For a non-UI diagnostic against the same real app-server client:

```sh
deno task smoke /path/to/repository "Question about the repository"
```

## Documentation

- [Documentation map](docs/README.md)
- [Product foundation](docs/FOUNDATION.md)
- [Architecture overview](docs/architecture/README.md)
- [First vertical slice](docs/architecture/vertical-slice.md)
- [Codex app-server integration](docs/architecture/codex-app-server.md)
- [Reliability and validation](docs/architecture/reliability.md)
- [Decision log](docs/architecture/decisions.md)
