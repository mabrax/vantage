# Vantage

Vantage is a local, Codex-first desktop workspace for software development. Its
first packaged vertical lets a developer point a Deno Desktop application at one
local Git repository, hold one ephemeral read-only Codex conversation, and stop
an active response without losing the open conversation.

## Run the first vertical

Prerequisites:

- macOS on Apple silicon (the primary development platform for Milestone 1);
- Deno `2.9.4` or newer (`2.9.4` fixes packaged desktop bindings); and
- a locally installed and authenticated `codex` CLI available on `PATH`.

```sh
deno task dev
```

Paste a Git repository path, wait for native readiness, and ask a question.
Follow-up prompts reuse the same native thread until Vantage closes. Stop
remains pending until Codex reports a terminal state; completed, interrupted,
and retryable failed turns make the prompt usable again.

Vantage deliberately does not persist or resume conversations and does not
implement multiple conversations, queued turns, steering, model controls,
approvals, rich activity, or write-enabled work.

Build the packaged application and run all repository checks with:

```sh
deno task package
deno task check
```

For a non-UI diagnostic against the same real app-server client:

```sh
deno task smoke /path/to/repository "Question about the repository"
```

Pass a third argument to exercise a context-dependent follow-up on the same
native thread:

```sh
deno task smoke /path/to/repository \
  "Remember the word amber, then reply ready." \
  "Which word did I ask you to remember?"
```

## Documentation

- [Documentation map](docs/README.md)
- [Product foundation](docs/FOUNDATION.md)
- [Architecture overview](docs/architecture/README.md)
- [First vertical slice](docs/architecture/vertical-slice.md)
- [Codex app-server integration](docs/architecture/codex-app-server.md)
- [Reliability and validation](docs/architecture/reliability.md)
- [Decision log](docs/architecture/decisions.md)
