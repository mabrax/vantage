# Vantage product foundation

Status: **Product direction**

Vantage is a local desktop command center for software development across Git repositories. It
brings agent conversations, project state, files, terminals, tasks, sessions, and larger plans into
one connected workspace.

This is not a release checklist. It describes the product Vantage should grow into. The current
delivery boundary lives in the [first vertical slice](architecture/vertical-slice.md), and current
technical decisions live in the [architecture overview](architecture/README.md).

## Product intent

Vantage should reduce the need to jump between terminals, file explorers, agent UIs, issue trackers,
repository tools, build logs, and planning documents while working across projects.

The app should eventually provide:

- one place to register and switch among local Git projects;
- one place to work with coding agents;
- one place to inspect files and rendered artifacts;
- one place to run and understand terminal activity;
- one place to see threads, tasks, plans, and progress; and
- one place to understand what is running, blocked, or waiting for intervention.

The intended feeling is a development battle station: locally powerful, observable, and organized
around the work rather than around any single tool.

## Product decisions

- Vantage is a local desktop application.
- A project is initially a local Git repository.
- Codex is the first provider and the first complete product experience.
- The first experience is one user working in one selected project and one Codex thread at a time.
- More providers may be supported later, but the common provider model must be extracted from real,
  validated integrations rather than designed in advance.
- Vantage owns its project registry, preferences, and UI projections. Git repositories, Codex
  history, and external systems remain their own sources of truth.
- Local power must remain visible and controllable through explicit runtime modes, approvals, and
  recoverable state.
- Files, terminals, tasks, and flow views remain part of the product direction even though they are
  outside the first chat vertical slice.

The desktop runtime, process topology, protocol, and persistence choices are architecture decisions,
not permanent product identity.

## Target user

The primary user is a developer or technical operator who works across multiple local repositories
and wants tight integration with their machine, tools, and agent workflows.

The product assumes the user is comfortable granting local power when useful, but wants to see what
is happening, understand when input is required, interrupt work, and recover after failure.

## Core concepts

Consistent names matter because Codex and Vantage both have lifecycle concepts:

| Concept | Meaning in Vantage |
| --- | --- |
| Project | A registered local Git repository and its Vantage metadata. |
| Thread | A durable conversation inside a project. It maps to a native Codex thread initially. |
| Turn | One user request and the agent activity it causes inside a thread. |
| Live session | The temporary runtime connection and child process serving an open thread. |
| Task | A unit of planned work that may later link to projects, threads, files, or plans. |

A live session is not the conversation's durable identity. Closing a process must not make a thread
disappear.

## Product surfaces

### Projects

Projects are the top-level navigation unit. Vantage should support registering repositories,
switching among them, showing repository identity and branch state, and opening project-scoped tools.

### Agent chat

The chat surface should support durable threads, streamed turns, tool activity, interruptions,
approvals, user-input requests, model and runtime choices, and clear recovery behavior.

Codex comes first. Future providers should feel coherent in Vantage without flattening capabilities
that are unique or useful.

### Files and artifacts

The file surface should grow from text and Markdown into code, images, PDFs, spreadsheets,
documents, logs, and structured data. Humans and agents should be able to refer to the same artifact
without leaving the project context.

### Terminal

The terminal is a foundational future surface. It should provide project-scoped shells, durable
terminal state where practical, command status, and eventual links to threads and tasks.

### Tasks and plans

Vantage should support local task lists, Kanban-style status, plans, and links among tasks, threads,
files, commits, and external trackers. Local task state must remain useful without requiring a cloud
service.

### Sessions and activity

An activity view should explain what is running, what happened, what changed, what is blocked, and
where work can be resumed. Over time it may combine chat turns, terminal activity, file changes,
approvals, errors, and generated artifacts.

### Flow view

A future interactive graph should make larger work legible: epics, plans, dependencies, agent
threads, blocked steps, intervention points, and relationships among artifacts. It is intended as a
work surface, not merely a diagram.

## Product principles

### Local first

Project access and app state start on the user's machine. Vantage should aggregate existing sources
of truth instead of copying them by default.

### Native capability before abstraction

The first integration should expose useful Codex behavior directly. Provider-neutral seams should
appear only when multiple concrete implementations show what is genuinely shared.

### Thin end-to-end slices

Each delivery should prove a complete user outcome across UI, persistence, process lifecycle, and
recovery. The first such outcome is Codex chat, not a collection of disconnected shells.

### Observable power

The interface should show runtime mode, active work, approvals, failures, and interruption controls.
Sensitive actions should be attributable to a project and turn.

### Recoverable state

Vantage should distinguish durable identity from live processes, avoid silently replaying uncertain
work, and make restart and resume behavior explicit.

## Long-term safety direction

Vantage should support both explicit approvals and policy-based autonomy. Sensitive actions include
file mutation, deletion, command execution, dependency installation, Git changes, long-running
services, network operations, and destructive local actions.

The UI should explain what will happen, where it will happen, which policy permits it, and whether it
is reversible. Provider output and paths remain untrusted input even in a local application.

## Direction still open

- How should activity from multiple projects be summarized without becoming noisy?
- Which file and terminal capabilities should follow the chat slice?
- What is the smallest useful local task model?
- How should local tasks synchronize with repository files or external trackers?
- What should the first flow view make actionable rather than merely visible?
- Which second provider would provide the best evidence for an eventual provider abstraction?

## North star

Vantage should become the local workspace where a developer can open a project, work with coding
agents, inspect and change artifacts, run commands, organize tasks, and see larger work unfold—with
enough control and context to trust what the system is doing.
