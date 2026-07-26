# Vantage

Vantage is a local, Codex-first desktop workspace for software development. Its
current packaged vertical keeps a persistent, ordered sidebar of canonical local
Git projects and remembers the selected workspace. Each project owns one saved,
read-only Codex conversation that continues only through its exact durable
native thread.

## Run the current vertical

Prerequisites:

- macOS on Apple silicon (the primary development platform for Milestone 1);
- Deno `2.9.4` or newer (`2.9.4` fixes packaged desktop bindings); and
- a locally installed and authenticated `codex` CLI available on `PATH`.

```sh
deno task dev
```

Paste a Git repository path into the sidebar, add more projects, and switch
among them. Vantage canonicalizes each Git root, rejects aliases, remembers
registration order and selection, and keeps unavailable saved paths visible for
recovery or explicit removal. Project removal forgets only Vantage-owned
metadata and leaves the repository and Codex-owned history untouched.

Literal prompts, ordered raw assistant source, and native terminal outcomes
restore after project switches and app relaunch. Existing conversations resume
only by their exact native thread ID; missing, incompatible, or failed native
history remains explicit and read-only. Vantage does not implement multiple
conversations, queued turns, steering, model controls, approvals, rich activity,
or write-enabled work.

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

Run the authenticated two-process durable resume proof with:

```sh
deno task native-resume-proof /path/to/repository
```

The proof starts a non-ephemeral native thread under the fixed read-only policy,
replaces app-server, resumes the exact thread ID, verifies context continuity,
archives the temporary proof thread, and reaps both owned processes.

## Documentation

- [Documentation map](docs/README.md)
- [Product foundation](docs/FOUNDATION.md)
- [Architecture overview](docs/architecture/README.md)
- [Rich response rendering](docs/architecture/rich-response-rendering.md)
- [Saved projects and conversations](docs/architecture/saved-conversations.md)
- [First vertical slice](docs/architecture/vertical-slice.md)
- [Codex app-server integration](docs/architecture/codex-app-server.md)
- [Reliability and validation](docs/architecture/reliability.md)
- [Decision log](docs/architecture/decisions.md)
