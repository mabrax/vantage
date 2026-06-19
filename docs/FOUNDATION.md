# Vantage Foundation

Vantage is a local Tauri command center for software development work across Git repositories. It gives one place to interact with headless development harnesses, inspect project state, manage tasks and sessions, read and render files, run terminals, and understand where work is inside larger plans or epics.

This is not an MVP document. Vantage is expected to grow continuously. Features may be added, reshaped, or removed as the product gets clearer. This document captures the current foundations and should be updated as decisions change.

## Fixed Decisions

- Vantage is a local desktop application built with Tauri.
- The initial project unit is a Git repository.
- Vantage acts as an aggregator command center for local development state.
- Harnesses should run in headless managed mode.
- The first agent experience is one chat session connected to one headless harness.
- Multi-harness routing, orchestration, and delegation are future extensions of the same foundation.
- Vantage should eventually support the full local development surface: reading and writing files, running commands, managing terminals, launching harnesses, tracking sessions, inspecting project state, and performing development actions.
- The safety model must support both explicit approvals and policy-based autonomy.

## Product Intent

Vantage should reduce the need to jump between terminals, file explorers, chat sessions, agent UIs, issue trackers, repo tools, build logs, and planning documents while working on multiple projects.

The app should feel like a battle station for development work:

- one place to open a Git repo,
- one place to chat with a headless harness,
- one place to inspect files and rendered documents,
- one place to run terminals and commands,
- one place to see sessions, tasks, plans, and progress,
- one place to understand what is happening now and what needs intervention.

## Target Users

The primary user is a developer or technical operator who works across multiple local repositories and wants tight integration with their machine, tools, agents, and development workflows.

The product assumes the user is comfortable granting local power when useful, but wants visibility, control, and recoverability.

## Core Surfaces

### Project Explorer

The project explorer manages Git repositories as first-class workspaces.

It should support:

- adding local Git repositories,
- switching between repositories,
- showing repo identity and current branch,
- surfacing dirty state and relevant project metadata,
- opening repo-scoped tools such as chat, files, terminal, tasks, and sessions.

### Chat And Harness Interaction

The first chat surface should connect one chat session to one headless harness.

Initial harness candidates include:

- Codex,
- Claude Code,
- pi dev,
- similar command-line or headless development agents.

The chat surface should support:

- sending prompts to a selected harness,
- streaming or polling harness output,
- showing tool/action progress when available,
- preserving session history,
- associating each session with a Git repo,
- making interruptions and approvals clear.

The harness architecture should be adapter-based. Each harness adapter should normalize process launch, input, output, lifecycle, metadata, and recoverable session state into a common Vantage model.

### Terminal

A terminal is foundational, not optional.

It should support:

- opening repo-scoped shells,
- running commands in the selected Git repository,
- preserving terminal sessions where practical,
- showing command state and exit codes,
- allowing terminals to be linked to tasks, sessions, or harness activity later.

### File Explorer

The file explorer should support:

- browsing the selected Git repository,
- opening files quickly,
- reading text files,
- rendering common document formats,
- showing binary or unsupported files safely,
- providing enough context for agents and humans to discuss files together.

File rendering should grow over time. Expected renderer categories include text, Markdown, code, images, PDFs, spreadsheets, documents, logs, and structured data.

### Tasks And Kanban

Task tracking is a core local work surface.

The task system should support:

- task lists,
- Kanban-style status views,
- linking tasks to Git repos,
- linking tasks to sessions,
- linking tasks to files or plans,
- lightweight updates without requiring an external tracker.

Vantage may aggregate from external trackers later, but local task state must be useful on its own.

### Sessions

Sessions represent units of active or historical work.

A session may include:

- a chat with a harness,
- terminal activity,
- file changes,
- task updates,
- plan steps,
- approvals,
- errors,
- generated artifacts,
- links to commits, branches, or PRs later.

The session view should answer:

- what is running,
- what happened,
- what is blocked,
- what needs user input,
- what changed,
- where to resume.

### Flow View

Vantage should include a React Flow-style map for larger work.

The flow view should help visualize and interact with:

- plans,
- epics,
- task dependencies,
- agent sessions,
- progress through a process,
- blocked steps,
- intervention points,
- relationships between files, tasks, sessions, and outcomes.

This is not just a diagram. It should become an interactive work surface where a user can inspect nodes, open related files or sessions, and eventually trigger actions.

## Harness Runner Foundation

Vantage should run harnesses headlessly from the Tauri backend.

The runner should be responsible for:

- launching harness processes,
- selecting the working directory,
- passing environment variables,
- capturing stdout, stderr, structured events, and exit state,
- sending user input,
- handling cancellation and interruption,
- preserving logs,
- recovering useful state after app restart where possible,
- enforcing approval and policy rules.

The first implementation can support one harness adapter and one active chat session. The architecture should still assume more adapters and richer routing later.

## Common Harness Adapter Shape

Each adapter should define:

- harness id,
- display name,
- availability check,
- launch command,
- required configuration,
- input protocol,
- output parser,
- session metadata,
- cancellation behavior,
- approval behavior,
- error normalization.

Adapters should avoid leaking harness-specific details into the UI unless the detail is useful to the user.

## State Model

Vantage is primarily an aggregator, but it needs durable local state for its own work surfaces.

Initial local state should cover:

- registered Git repositories,
- app preferences,
- harness configuration,
- chat sessions,
- terminal sessions where practical,
- tasks,
- session metadata,
- flow nodes and edges,
- file/render history where useful.

Repo files, Git history, external trackers, and harness logs may remain external sources of truth. Vantage should reference and aggregate them rather than copying everything by default.

## Safety Model

Vantage should support two safety modes:

- explicit approvals for sensitive actions,
- policy-based autonomy for actions the user has pre-approved.

Sensitive actions include:

- editing files,
- deleting files,
- running commands,
- installing dependencies,
- modifying Git state,
- launching long-running services,
- invoking harnesses with write access,
- networked actions,
- destructive local operations.

Approval prompts should be clear about:

- what will run,
- where it will run,
- what files or systems may be affected,
- whether the action is reversible,
- what policy allowed or blocked it.

## Initial Build Sequence

This is not an MVP boundary. It is the current practical order for laying the foundation.

1. Create the Tauri application shell.
2. Add repository registration and project switching.
3. Add a repo-scoped file explorer with basic text and Markdown rendering.
4. Add a repo-scoped terminal.
5. Add the harness runner foundation.
6. Add one headless harness adapter.
7. Add one chat session connected to that harness.
8. Add durable session records.
9. Add local task tracking.
10. Add a basic Kanban/task view.
11. Add the first session view.
12. Add the first flow view for plans, tasks, sessions, and progress.

## Open Questions

- Which harness should be integrated first?
- What local database or persistence layer should Vantage use?
- Should terminals be fully embedded PTYs from the start, or can the first version use a simpler command runner?
- Which file renderers are required first?
- How should Vantage detect and represent active work across multiple Git repositories?
- What should the first policy-based autonomy controls look like?
- Should task state live only in Vantage state, optionally in repo files, or both?

## Current North Star

Vantage should become the local command center where a developer can open a Git repo, talk to a headless agent, inspect and render files, run terminals, track tasks, review sessions, and see work unfold through a visual process map.

The foundation must make those surfaces feel connected from the beginning, even while individual features continue to change.
