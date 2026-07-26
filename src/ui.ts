import { MARKDOWN_JAVASCRIPT } from "./markdown.ts";

export interface ProjectRemovalUiState {
  readonly sessionReady: boolean;
  readonly turnActive: boolean;
  readonly readyRepository: string | null;
  readonly activeAssistant: unknown | null;
  readonly assistantMessages: readonly unknown[];
  readonly composerEnabled: boolean;
}

export interface ProjectRemovalTransition extends ProjectRemovalUiState {
  readonly removesSelectedProject: boolean;
  readonly shouldResetConversation: boolean;
}

export interface ConversationPresentationProject {
  readonly canonicalRoot: string;
  readonly availability: string;
  readonly unavailableMessage: string | null;
  readonly unavailableAction: string | null;
}

export interface ConversationPresentationSaved {
  readonly readOnly: boolean;
  readonly nativeResumeFailure: string | null;
  readonly turns: readonly unknown[];
}

export type ConversationPresentationMode =
  | "empty"
  | "repository_unavailable"
  | "recovered_unresolved"
  | "native_non_resumable"
  | "opening"
  | "ready";

export interface ConversationPresentation<
  Saved extends ConversationPresentationSaved = ConversationPresentationSaved,
> {
  readonly mode: ConversationPresentationMode;
  readonly savedConversation: Saved | null;
  readonly showUnavailable: boolean;
  readonly showConversation: boolean;
  readonly restoreTranscript: boolean;
  readonly composerReady: boolean;
  readonly canRetryNative: boolean;
  readonly statusKind: "neutral" | "failed" | null;
  readonly statusTitle: string | null;
  readonly statusDetail: string | null;
}

export interface AvailabilityRefreshProject {
  readonly id: string;
  readonly canonicalRoot: string;
  readonly availability: string;
}

export function shouldActivateAfterAvailabilityRefresh(
  previous: AvailabilityRefreshProject | null,
  current: AvailabilityRefreshProject | null,
): boolean {
  return previous !== null &&
    current !== null &&
    previous.id === current.id &&
    previous.canonicalRoot === current.canonicalRoot &&
    previous.availability !== "available" &&
    current.availability === "available";
}

export interface UnresolvedTurnProjection {
  readonly turnActive: false;
  readonly composerReady: false;
  readonly terminalClass: "message-terminal unresolved";
  readonly terminalText: string;
}

export type RetryAction = "initialize" | "activate" | "refresh";

export function deriveRetryAction(
  appInitialized: boolean,
  selectedAvailability: string | null,
): RetryAction {
  if (!appInitialized) return "initialize";
  return selectedAvailability === "available" ? "activate" : "refresh";
}

export function projectRemovalDetail(removesSelectedProject: boolean): string {
  const processDetail = removesSelectedProject
    ? "Vantage will stop this project's selected app-server process before forgetting its Vantage-owned registration and conversation metadata."
    : "Vantage will keep the selected project's app-server and conversation running while forgetting only this project's Vantage-owned registration and conversation metadata.";
  return processDetail +
    " The repository and Codex-owned native history remain untouched. Re-adding this path later creates a fresh Vantage project without restoring its removed Vantage conversation.";
}

export function deriveUnresolvedTurnProjection(
  recoveryLabel: string,
): UnresolvedTurnProjection {
  return {
    turnActive: false,
    composerReady: false,
    terminalClass: "message-terminal unresolved",
    terminalText: "Unresolved · " + recoveryLabel,
  };
}

export function deriveConversationPresentation<
  Saved extends ConversationPresentationSaved,
>(
  selected: ConversationPresentationProject | null,
  saved: Saved | null,
  readyRepository: string | null,
  turnActive: boolean,
): ConversationPresentation<Saved> {
  if (selected === null) {
    return {
      mode: "empty",
      savedConversation: null,
      showUnavailable: false,
      showConversation: false,
      restoreTranscript: false,
      composerReady: false,
      canRetryNative: false,
      statusKind: null,
      statusTitle: null,
      statusDetail: null,
    };
  }

  if (selected.availability !== "available") {
    const message = selected.unavailableMessage ||
      "The saved repository is unavailable.";
    const action = selected.unavailableAction ||
      "Restore the saved path, refresh availability, or remove this project.";
    return {
      mode: "repository_unavailable",
      savedConversation: saved,
      showUnavailable: true,
      showConversation: saved !== null,
      restoreTranscript: saved !== null,
      composerReady: false,
      canRetryNative: false,
      statusKind: "failed",
      statusTitle: "Project unavailable · saved history is read-only",
      statusDetail: message + " " + action +
        " Vantage will not start Codex or retarget this conversation while the exact canonical root is unavailable.",
    };
  }

  if (saved?.readOnly) {
    if (saved.nativeResumeFailure !== null) {
      return {
        mode: "native_non_resumable",
        savedConversation: saved,
        showUnavailable: false,
        showConversation: true,
        restoreTranscript: !turnActive,
        composerReady: false,
        canRetryNative: true,
        statusKind: "failed",
        statusTitle: "Saved conversation is read-only",
        statusDetail: "Native resume is " +
          saved.nativeResumeFailure.replaceAll("_", " ") +
          ". Retry only the exact saved native ID, or remove this project. Vantage will not start a replacement conversation.",
      };
    }
    return {
      mode: "recovered_unresolved",
      savedConversation: saved,
      showUnavailable: false,
      showConversation: true,
      restoreTranscript: !turnActive,
      composerReady: false,
      canRetryNative: false,
      statusKind: "failed",
      statusTitle: "Saved conversation is read-only",
      statusDetail:
        "An unresolved saved turn is preserved exactly. Automatic replay and transcript reconstruction are disabled; no reconciliation retry is available in this milestone.",
    };
  }

  const ready = readyRepository === selected.canonicalRoot;
  return {
    mode: ready ? "ready" : "opening",
    savedConversation: saved,
    showUnavailable: false,
    showConversation: saved !== null,
    restoreTranscript: saved !== null && !turnActive,
    composerReady: ready && !turnActive,
    canRetryNative: false,
    statusKind: ready ? null : "neutral",
    statusTitle: ready ? null : "Saved conversation loaded",
    statusDetail: ready
      ? null
      : "Saved history remains read-only while Vantage starts or resumes the exact native conversation.",
  };
}

export function transitionProjectRemoval(
  projectId: string,
  selectedProjectId: string | null,
  state: ProjectRemovalUiState,
): ProjectRemovalTransition {
  if (projectId !== selectedProjectId) {
    return {
      ...state,
      removesSelectedProject: false,
      shouldResetConversation: false,
    };
  }
  return {
    sessionReady: false,
    turnActive: false,
    readyRepository: null,
    activeAssistant: null,
    assistantMessages: [],
    composerEnabled: false,
    removesSelectedProject: true,
    shouldResetConversation: true,
  };
}

export const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    >
    <title>Vantage</title>
    <link rel="stylesheet" href="/styles.css">
    <script src="/app.js" defer></script>
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar" aria-labelledby="projects-heading">
        <header class="brand">
          <div class="mark" aria-hidden="true">V</div>
          <div>
            <p class="eyebrow">Vantage</p>
            <h1>Projects</h1>
          </div>
        </header>

        <div class="sidebar-heading">
          <div>
            <h2 id="projects-heading">Saved Git projects</h2>
          <p>Canonical local roots with one saved Codex conversation each.</p>
          </div>
          <button id="refresh-projects" class="icon-button" type="button" title="Check saved project availability" aria-label="Check saved project availability">↻</button>
        </div>

        <div id="project-empty" class="project-empty">
          <strong>Add your first local Git repository</strong>
          <p>Paste an accessible path below. Vantage saves its registration and one durable native Codex conversation.</p>
        </div>

        <nav id="project-list" class="project-list" aria-label="Saved projects"></nav>

        <form id="repository-form" class="add-project">
          <label for="repository-path">Add repository path</label>
          <input id="repository-path" name="repository" type="text" autocomplete="off" spellcheck="false" aria-describedby="repository-help" placeholder="/Users/you/code/project" required>
          <p id="repository-help">Nested paths and symlink aliases resolve to one canonical Git root.</p>
          <button id="repository-submit" type="submit">Add project</button>
        </form>
      </aside>

      <main class="workspace">
        <header class="workspace-header">
          <div>
            <p class="eyebrow">Local Codex workspace</p>
            <h1 id="workspace-title">Choose a saved project</h1>
            <p id="workspace-path" class="workspace-path">No native process is running.</p>
          </div>
          <button id="workspace-remove" class="danger-secondary" type="button" hidden>Remove project</button>
        </header>

        <section id="workspace-empty" class="panel workspace-empty">
          <div class="empty-mark" aria-hidden="true">⌘</div>
          <h2>Your local workspaces, one switch away.</h2>
          <p>Add an accessible Git repository from the sidebar. Vantage validates and saves only its canonical root and Vantage-owned metadata; it never takes ownership of repository contents.</p>
        </section>

        <section id="project-unavailable" class="panel unavailable-panel" hidden>
          <p class="eyebrow">Project unavailable</p>
          <h2 id="unavailable-title">The saved repository cannot be opened.</h2>
          <p id="unavailable-detail"></p>
          <button id="unavailable-refresh" class="secondary" type="button">Check again</button>
        </section>

        <section id="conversation" class="panel conversation" aria-labelledby="conversation-heading" hidden>
          <div class="section-heading">
            <span class="step">CHAT</span>
            <div>
              <h2 id="conversation-heading">Ask Codex</h2>
              <p>Literal prompts and raw assistant source are saved locally and continued only through the exact native Codex thread.</p>
            </div>
          </div>
          <div id="transcript" class="transcript" aria-live="polite"></div>
          <form id="prompt-form">
            <label for="prompt">Question</label>
            <textarea id="prompt" name="prompt" rows="4" maxlength="32000" placeholder="What does this repository do, based on its source?" required></textarea>
            <div class="composer-footer">
              <span class="policy">Read-only · existing Codex defaults</span>
              <div class="composer-actions">
                <button id="turn-stop" class="stop" type="button" hidden>Stop</button>
                <button id="prompt-submit" type="submit">Ask Codex</button>
              </div>
            </div>
          </form>
        </section>

        <section id="status" class="status neutral" role="status" aria-live="polite">
          <span id="status-indicator" class="status-indicator" aria-hidden="true"></span>
          <div>
            <strong id="status-title">Opening saved projects</strong>
            <p id="status-detail">Vantage is loading its local registry.</p>
          </div>
          <button id="retry" class="secondary" type="button" hidden>Retry</button>
        </section>
      </main>
    </div>

    <dialog id="remove-dialog" class="remove-dialog" aria-labelledby="remove-title">
      <form method="dialog">
        <div>
          <p class="eyebrow">Confirm removal</p>
          <h2 id="remove-title">Forget this project from Vantage?</h2>
          <p id="remove-project-name" class="remove-project-name"></p>
          <p id="remove-detail"></p>
        </div>
        <div class="dialog-actions">
          <button id="remove-cancel" class="secondary" value="cancel" type="button">Cancel</button>
          <button id="remove-confirm" class="danger" value="confirm" type="button">Remove from Vantage</button>
        </div>
      </form>
    </dialog>
    <dialog id="switch-dialog" class="remove-dialog" aria-labelledby="switch-title">
      <form method="dialog">
        <div>
          <p class="eyebrow">Active Codex turn</p>
          <h2 id="switch-title">Stop this turn and switch projects?</h2>
          <p>Cancel keeps the current project and turn untouched. Confirm asks Codex to stop, preserves any unresolved durable truth, reaps the exact owned process, and only then opens the target project.</p>
        </div>
        <div class="dialog-actions">
          <button id="switch-cancel" class="secondary" value="cancel" type="button">Keep current project</button>
          <button id="switch-confirm" class="danger" value="confirm" type="button">Stop and switch</button>
        </div>
      </form>
    </dialog>
  </body>
</html>`;

export const CSS = `:root {
  color-scheme: dark;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #0b0f14;
  color: #edf2f7;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-width: 680px;
  min-height: 100vh;
  background:
    radial-gradient(circle at 8% 0%, rgba(70, 119, 105, 0.2), transparent 36rem),
    linear-gradient(180deg, #0c1117 0%, #080b0f 100%);
}

button, input, textarea { font: inherit; }

.app-shell {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  padding: 28px 22px 22px;
  border-right: 1px solid #202a34;
  background: rgba(9, 14, 19, 0.94);
}

.workspace {
  width: min(920px, calc(100% - 64px));
  margin: 0 auto;
  padding: 46px 0 44px;
}

.brand {
  display: grid;
  grid-template-columns: 42px 1fr;
  gap: 12px;
  align-items: start;
  margin-bottom: 30px;
}

.mark {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 1px solid #6b9b88;
  border-radius: 12px;
  background: linear-gradient(145deg, #244338, #13241f);
  color: #b9ecd7;
  font-size: 19px;
  font-weight: 700;
  box-shadow: 0 16px 45px rgba(0, 0, 0, 0.25);
}

h1, h2, p { margin-top: 0; }
h1 { margin-bottom: 10px; font-size: clamp(28px, 4vw, 42px); letter-spacing: -0.035em; }
h2 { margin-bottom: 6px; font-size: 18px; letter-spacing: -0.01em; }
.brand h1 { margin: 0; font-size: 22px; }
.brand .eyebrow { margin-bottom: 4px; }

.eyebrow {
  margin-bottom: 9px;
  color: #83b6a1;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.lede, .section-heading p, .status p, .sidebar p, .workspace-header p,
.workspace-empty p, .unavailable-panel p, .remove-dialog p {
  color: #91a0ad;
  line-height: 1.55;
}

.lede { max-width: 660px; margin-bottom: 0; }

.sidebar-heading, .workspace-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 14px;
}
.sidebar-heading { margin-bottom: 16px; }
.sidebar-heading h2 { margin-bottom: 4px; font-size: 14px; }
.sidebar-heading p { margin-bottom: 0; font-size: 11px; }
.icon-button {
  width: 32px;
  min-width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid #2f3d47;
  background: transparent;
  color: #9badb8;
}
.project-empty {
  margin-bottom: 14px;
  padding: 15px;
  border: 1px dashed #33423d;
  border-radius: 12px;
  background: rgba(46, 75, 63, 0.12);
}
.project-empty strong { display: block; margin-bottom: 6px; font-size: 13px; }
.project-empty p { margin: 0; font-size: 11px; }
.project-list {
  display: grid;
  gap: 7px;
  min-height: 0;
  margin-bottom: 18px;
  overflow-y: auto;
}
.project-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 30px;
  gap: 5px;
  padding: 5px;
  border: 1px solid transparent;
  border-radius: 11px;
}
.project-item.selected {
  border-color: #395849;
  background: rgba(62, 100, 82, 0.19);
}
.project-select {
  min-width: 0;
  padding: 8px;
  background: transparent;
  color: #dbe4e9;
  text-align: left;
}
.project-select:hover:not(:disabled) { background: rgba(255, 255, 255, 0.04); }
.project-name, .project-path { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-name { margin-bottom: 3px; font-size: 13px; }
.project-path { color: #778792; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
.project-state { display: block; margin-top: 5px; color: #df9c72; font-size: 10px; }
.project-remove {
  width: 30px;
  height: 30px;
  padding: 0;
  align-self: center;
  background: transparent;
  color: #8e9aa3;
}
.project-remove:hover:not(:disabled) { background: rgba(143, 71, 66, 0.25); color: #efaaa2; }
.add-project { margin-top: auto; padding-top: 16px; border-top: 1px solid #202a34; }
.add-project input { margin-bottom: 7px; }
.add-project p { margin-bottom: 10px; font-size: 10px; }
.add-project button { width: 100%; min-height: 40px; }

.workspace-header { margin-bottom: 24px; }
.workspace-header h1 { margin-bottom: 7px; }
.workspace-path {
  max-width: 680px;
  margin-bottom: 0;
  overflow-wrap: anywhere;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.workspace-empty { padding: 54px 38px; text-align: center; }
.workspace-empty h2 { font-size: 24px; }
.workspace-empty p { max-width: 590px; margin: 0 auto; }
.empty-mark { margin-bottom: 15px; color: #77ad95; font-size: 32px; }
.unavailable-panel { border-color: #5d4432; background: rgba(57, 38, 26, 0.77); }
.unavailable-panel .secondary { min-height: 38px; }
.danger-secondary {
  min-height: 38px;
  border: 1px solid #71443f;
  background: transparent;
  color: #efaaa2;
}
.danger-secondary:hover:not(:disabled) { background: rgba(117, 68, 63, 0.22); }
.remove-dialog {
  width: min(470px, calc(100% - 32px));
  padding: 0;
  border: 1px solid #46515a;
  border-radius: 16px;
  background: #111820;
  color: #edf2f7;
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.58);
}
.remove-dialog::backdrop { background: rgba(2, 5, 8, 0.72); }
.remove-dialog form { padding: 24px; }
.remove-project-name {
  padding: 10px 12px;
  border-radius: 8px;
  background: #0a0f14;
  overflow-wrap: anywhere;
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dialog-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 20px; }
.dialog-actions button { min-height: 40px; }
.danger { background: #d77f76; color: #230c0a; }
.danger:hover:not(:disabled) { background: #e8958c; }

.panel, .status {
  border: 1px solid #202a34;
  border-radius: 18px;
  background: rgba(16, 22, 29, 0.91);
  box-shadow: 0 26px 70px rgba(0, 0, 0, 0.22);
}

.panel { padding: 26px; margin-bottom: 16px; }

.section-heading {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 12px;
  margin-bottom: 22px;
}

.section-heading p { margin-bottom: 0; font-size: 14px; }

.step {
  color: #6f8279;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  padding-top: 4px;
}

label {
  display: block;
  margin-bottom: 8px;
  color: #c6d0d9;
  font-size: 13px;
  font-weight: 650;
}

.input-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; }

input, textarea {
  width: 100%;
  border: 1px solid #2a3743;
  border-radius: 11px;
  outline: none;
  background: #0b1015;
  color: #f4f7fa;
  transition: border-color 130ms ease, box-shadow 130ms ease;
}

input { height: 46px; padding: 0 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
textarea { resize: vertical; min-height: 108px; padding: 13px 14px; line-height: 1.5; }
input:focus, textarea:focus { border-color: #659881; box-shadow: 0 0 0 3px rgba(91, 146, 122, 0.14); }
input:disabled, textarea:disabled { opacity: 0.62; cursor: not-allowed; }

button {
  border: 0;
  border-radius: 10px;
  padding: 0 18px;
  background: #a7ddc5;
  color: #0b1712;
  font-weight: 750;
  cursor: pointer;
}

button:hover:not(:disabled) { background: #bcebd6; }
button:disabled { opacity: 0.45; cursor: not-allowed; }

.secondary {
  min-height: 36px;
  border: 1px solid #35434e;
  background: transparent;
  color: #d4dde5;
}

.repository-result {
  align-items: center;
  gap: 9px;
  margin-top: 16px;
  color: #b5c1ca;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.repository-result:not([hidden]) { display: flex; }
.repo-dot { width: 8px; height: 8px; border-radius: 50%; background: #72c39d; box-shadow: 0 0 0 4px rgba(114, 195, 157, 0.1); }

.transcript:empty { display: none; }
.transcript { display: grid; min-width: 0; gap: 14px; margin-bottom: 18px; }
.message { min-width: 0; max-width: 100%; border-left: 2px solid #2b3a45; padding: 4px 0 4px 15px; }
.message.user { border-color: #567564; }
.message-role { margin-bottom: 6px; color: #788894; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.message-body { min-width: 0; margin: 0; color: #dfe6ec; line-height: 1.62; overflow-wrap: anywhere; }
.message.user .message-body { white-space: pre-wrap; }
.message.assistant .message-body.render-fallback { white-space: pre-wrap; }
.message-body > :first-child { margin-top: 0; }
.message-body > :last-child { margin-bottom: 0; }
.message-body p, .message-body ul, .message-body ol, .message-body blockquote,
.message-body .table-scroll, .message-body .code-block {
  margin: 0 0 0.9em;
}
.message-body h1, .message-body h2, .message-body h3,
.message-body h4, .message-body h5, .message-body h6 {
  margin: 1.25em 0 0.48em;
  color: #f2f6f8;
  line-height: 1.25;
  letter-spacing: -0.018em;
}
.message-body h1 { font-size: 1.55em; }
.message-body h2 { font-size: 1.35em; }
.message-body h3 { font-size: 1.18em; }
.message-body h4, .message-body h5, .message-body h6 { font-size: 1em; }
.message-body ul, .message-body ol { padding-left: 1.55em; }
.message-body li + li { margin-top: 0.26em; }
.message-body blockquote {
  padding: 0.1em 0 0.1em 0.9em;
  border-left: 3px solid #465967;
  color: #aebac4;
}
.message-body hr { margin: 1.2em 0; border: 0; border-top: 1px solid #2e3a45; }
.message-body strong { color: #f2f5f7; }
.inline-code {
  border: 1px solid #2b3944;
  border-radius: 5px;
  padding: 0.08em 0.32em;
  background: #0a0f14;
  color: #c4ead9;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
}
.markdown-link {
  color: #8fd8bc;
  text-decoration: underline;
  text-decoration-color: rgba(143, 216, 188, 0.48);
  text-underline-offset: 0.16em;
  cursor: help;
}
.markdown-link::after { content: " ↗"; font-size: 0.72em; text-decoration: none; }
.unsafe-link { color: #d9a49d; text-decoration-style: dotted; }
.unsafe-link::after { content: " blocked"; font-size: 0.68em; }
.omitted-image { color: #a8b2ba; font-style: italic; }
.task-list-item { list-style: none; margin-left: -1.42em; }
.task {
  display: inline-grid;
  place-items: center;
  width: 1em;
  height: 1em;
  margin-right: 0.42em;
  border: 1px solid #586a77;
  border-radius: 3px;
  color: #0b1712;
  font-size: 0.78em;
  vertical-align: -0.08em;
}
.task.checked { border-color: #72c39d; background: #72c39d; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.message-body table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 0.92em; }
.message-body th, .message-body td {
  min-width: 7rem;
  border: 1px solid #2b3944;
  padding: 0.48em 0.65em;
  text-align: left;
  vertical-align: top;
}
.message-body th { background: #121a21; color: #edf2f5; font-weight: 700; }
.message-body tr:nth-child(even) td { background: rgba(22, 30, 37, 0.56); }
.message-body .align-center { text-align: center; }
.message-body .align-right { text-align: right; }
.code-block {
  min-width: 0;
  overflow: hidden;
  border: 1px solid #293641;
  border-radius: 10px;
  background: #080d12;
}
.code-block.streaming { border-color: #4c4636; }
.code-block figcaption {
  display: flex;
  min-height: 35px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 7px 5px 12px;
  border-bottom: 1px solid #293641;
  background: #111820;
}
.code-language {
  color: #93a4b1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 650;
}
.copy-code {
  min-height: 25px;
  padding: 0 9px;
  border: 1px solid #344551;
  border-radius: 6px;
  background: #172129;
  color: #cbd5dc;
  font-size: 11px;
}
.copy-code:hover:not(:disabled) { background: #202d37; }
.code-block pre {
  max-width: 100%;
  margin: 0;
  padding: 14px;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  color: #dce6ec;
  font: 12px/1.58 ui-monospace, SFMono-Regular, Menlo, monospace;
  tab-size: 2;
}
.code-block code { white-space: pre; }
.visual-block {
  max-width: 100%;
  margin: 15px 0;
  overflow: hidden;
  border: 1px solid #2a3944;
  border-radius: 8px;
  background: #111820;
}
.visual-block figcaption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 38px;
  padding: 6px 10px;
  border-bottom: 1px solid #293641;
}
.visual-label {
  color: #b6c5cf;
  font-size: 12px;
  font-weight: 650;
}
.visual-viewport {
  display: grid;
  max-width: 100%;
  max-height: 540px;
  padding: 14px;
  overflow: auto;
  overscroll-behavior: contain;
  background: #f7fafb;
}
.diagram-svg {
  display: block;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  max-height: 500px;
  margin: auto;
  color: #172129;
}
.diagram-node {
  fill: #e7f0f4;
  stroke: #375466;
  stroke-width: 2;
}
.diagram-node-label {
  fill: #172129;
  font: 600 13px ui-sans-serif, system-ui, sans-serif;
}
.diagram-edge {
  stroke: #587080;
  stroke-width: 2;
}
.diagram-lifeline, .diagram-message-dashed {
  stroke: #738896;
  stroke-width: 1.5;
  stroke-dasharray: 6 5;
}
.diagram-group {
  fill: rgba(223, 234, 240, 0.38);
  stroke: #9aadb9;
  stroke-width: 1.5;
  stroke-dasharray: 5 4;
}
.diagram-group-label {
  fill: #354b59;
  font: 600 11px ui-sans-serif, system-ui, sans-serif;
}
.diagram-sequence-block {
  fill: rgba(223, 234, 240, 0.24);
  stroke: #9aadb9;
  stroke-width: 1.5;
}
.diagram-arrow { fill: #587080; }
.diagram-edge-label {
  fill: #354b59;
  font: 11px ui-sans-serif, system-ui, sans-serif;
  paint-order: stroke;
  stroke: #f7fafb;
  stroke-width: 4px;
}
.visual-source {
  max-width: 100%;
  border-top: 1px solid #293641;
}
.visual-source summary {
  padding: 9px 11px;
  color: #93a4b1;
  cursor: pointer;
  font-size: 11px;
  font-weight: 650;
}
.visual-source pre {
  max-width: 100%;
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  border-top: 1px solid #293641;
  color: #dce6ec;
  font: 12px/1.58 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.visual-source code { white-space: pre; }
.visual-error {
  margin: 0;
  padding: 10px 14px 0;
  color: #efaaa2;
  font-size: 12px;
}
.visual-fallback .visual-source { border-top: 0; }
.copy-fallback { position: fixed; inset: -10000px auto auto -10000px; width: 1px; height: 1px; }
.message.assistant .message-body:empty::after { content: "Waiting for Codex…"; color: #6f7c86; font-style: italic; }
.message-terminal { margin: 9px 0 0; color: #7f8d98; font-size: 11px; }
.message-terminal.completed { color: #72c39d; }
.message-terminal.interrupted, .message-terminal.failed { color: #df8b82; }
.message-terminal.unresolved { color: #d9ad61; }

.composer-footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 10px; }
.composer-footer button { min-height: 42px; }
.composer-actions { display: flex; gap: 9px; }
.stop { border: 1px solid #75443f; background: transparent; color: #efaaa2; }
.stop:hover:not(:disabled) { background: rgba(117, 68, 63, 0.22); }
.policy { color: #73818c; font-size: 12px; }

.status {
  display: grid;
  grid-template-columns: 12px 1fr auto;
  gap: 13px;
  align-items: center;
  padding: 17px 20px;
}
.status strong { display: block; margin-bottom: 3px; font-size: 14px; }
.status p { margin-bottom: 0; font-size: 12px; }
.status-indicator { width: 10px; height: 10px; border-radius: 50%; background: #66727d; }
.status.running .status-indicator { background: #d9ad61; animation: pulse 1.35s ease-in-out infinite; }
.status.completed .status-indicator { background: #72c39d; }
.status.failed .status-indicator { background: #e0776c; }

@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(217, 173, 97, 0.25); }
  50% { box-shadow: 0 0 0 7px rgba(217, 173, 97, 0); }
}

@media (max-width: 820px) {
  body { min-width: 0; }
  .app-shell { grid-template-columns: 1fr; }
  .sidebar { min-height: auto; border-right: 0; border-bottom: 1px solid #202a34; }
  .workspace { width: min(100% - 28px, 920px); padding-top: 30px; }
  .project-list { max-height: 250px; }
  .status { grid-template-columns: 12px 1fr; }
  .status button { grid-column: 2; justify-self: start; min-height: 36px; }
}`;

export const JAVASCRIPT = MARKDOWN_JAVASCRIPT + `(() => {
  "use strict";

  const deriveConversationPresentation = (${deriveConversationPresentation.toString()});
  const deriveRetryAction = (${deriveRetryAction.toString()});
  const deriveUnresolvedTurnProjection = (${deriveUnresolvedTurnProjection.toString()});
  const projectRemovalDetail = (${projectRemovalDetail.toString()});
  const shouldActivateAfterAvailabilityRefresh = (${shouldActivateAfterAvailabilityRefresh.toString()});
  const transitionProjectRemoval = (${transitionProjectRemoval.toString()});
  const nativeBindings = globalThis.bindings;
  const repositoryForm = document.querySelector("#repository-form");
  const repositoryInput = document.querySelector("#repository-path");
  const repositorySubmit = document.querySelector("#repository-submit");
  const projectEmpty = document.querySelector("#project-empty");
  const projectList = document.querySelector("#project-list");
  const refreshProjects = document.querySelector("#refresh-projects");
  const workspaceTitle = document.querySelector("#workspace-title");
  const workspacePath = document.querySelector("#workspace-path");
  const workspaceRemove = document.querySelector("#workspace-remove");
  const workspaceEmpty = document.querySelector("#workspace-empty");
  const projectUnavailable = document.querySelector("#project-unavailable");
  const unavailableTitle = document.querySelector("#unavailable-title");
  const unavailableDetail = document.querySelector("#unavailable-detail");
  const unavailableRefresh = document.querySelector("#unavailable-refresh");
  const conversation = document.querySelector("#conversation");
  const promptForm = document.querySelector("#prompt-form");
  const promptInput = document.querySelector("#prompt");
  const promptSubmit = document.querySelector("#prompt-submit");
  const turnStop = document.querySelector("#turn-stop");
  const transcript = document.querySelector("#transcript");
  const status = document.querySelector("#status");
  const statusTitle = document.querySelector("#status-title");
  const statusDetail = document.querySelector("#status-detail");
  const retry = document.querySelector("#retry");
  const removeDialog = document.querySelector("#remove-dialog");
  const removeProjectName = document.querySelector("#remove-project-name");
  const removeDetail = document.querySelector("#remove-detail");
  const removeCancel = document.querySelector("#remove-cancel");
  const removeConfirm = document.querySelector("#remove-confirm");
  const switchDialog = document.querySelector("#switch-dialog");
  const switchCancel = document.querySelector("#switch-cancel");
  const switchConfirm = document.querySelector("#switch-confirm");

  const assistantMessages = [];
  let activeAssistant = null;
  let sessionReady = false;
  let turnActive = false;
  let registryBusy = false;
  let registry = { projects: [], selectedProjectId: null };
  let removalProjectId = null;
  let pendingSwitchProjectId = null;
  let readyRepository = null;
  let appInitialized = false;

  const setStatus = (kind, title, detail, canRetry = false) => {
    status.className = "status " + kind;
    statusTitle.textContent = title;
    statusDetail.textContent = detail;
    retry.hidden = !canRetry;
  };

  const setRepositoryBusy = (busy) => {
    registryBusy = busy;
    repositoryInput.disabled = busy || turnActive;
    repositorySubmit.disabled = busy || turnActive;
    refreshProjects.disabled = busy || turnActive;
    unavailableRefresh.disabled = busy || turnActive;
    workspaceRemove.disabled = busy;
    removeConfirm.disabled = busy;
    retry.disabled = busy || turnActive;
    renderProjects();
  };

  const setComposerReady = (ready) => {
    promptInput.disabled = !ready;
    promptSubmit.disabled = !ready;
    turnStop.hidden = ready || !turnActive;
    turnStop.disabled = ready || !turnActive;
  };

  const resetConversation = () => {
    sessionReady = false;
    turnActive = false;
    readyRepository = null;
    assistantMessages.length = 0;
    activeAssistant = null;
    transcript.replaceChildren();
    conversation.hidden = true;
    setComposerReady(false);
    setRepositoryBusy(registryBusy);
  };

  const selectedProject = () =>
    registry.projects.find((project) => project.id === registry.selectedProjectId) || null;

  const showRemoval = (project) => {
    if (registryBusy) return;
    removalProjectId = project.id;
    removeProjectName.textContent = project.canonicalRoot;
    removeDetail.textContent = projectRemovalDetail(
      project.id === registry.selectedProjectId,
    );
    if (typeof removeDialog.showModal === "function") {
      removeDialog.showModal();
    } else {
      removeDialog.hidden = false;
    }
  };

  const closeRemoval = () => {
    removalProjectId = null;
    if (typeof removeDialog.close === "function") {
      removeDialog.close();
    } else {
      removeDialog.hidden = true;
    }
  };

  const renderProjects = () => {
    projectList.replaceChildren();
    projectEmpty.hidden = registry.projects.length !== 0;
    for (const project of registry.projects) {
      const item = document.createElement("div");
      item.className = "project-item" + (project.selected ? " selected" : "");

      const select = document.createElement("button");
      select.className = "project-select";
      select.type = "button";
      select.disabled = registryBusy;
      select.setAttribute("aria-current", project.selected ? "page" : "false");
      const name = document.createElement("strong");
      name.className = "project-name";
      name.textContent = project.name;
      const path = document.createElement("span");
      path.className = "project-path";
      path.textContent = project.canonicalRoot;
      select.append(name, path);
      if (project.availability !== "available") {
        const availability = document.createElement("span");
        availability.className = "project-state";
        availability.textContent = "Unavailable · " + project.availability.replaceAll("_", " ");
        select.append(availability);
      }
      select.addEventListener("click", () => void chooseProject(project.id));

      const remove = document.createElement("button");
      remove.className = "project-remove";
      remove.type = "button";
      remove.title = "Remove " + project.name + " from Vantage";
      remove.setAttribute("aria-label", remove.title);
      remove.textContent = "×";
      remove.disabled = registryBusy;
      remove.addEventListener("click", () => showRemoval(project));
      item.append(select, remove);
      projectList.append(item);
    }
  };

  const applyRegistry = (snapshot) => {
    registry = snapshot;
    renderProjects();
    const selected = selectedProject();
    const presentation = deriveConversationPresentation(
      selected,
      snapshot.conversation,
      readyRepository,
      turnActive,
    );
    workspaceEmpty.hidden = selected !== null;
    workspaceRemove.hidden = selected === null;
    if (!selected) {
      resetConversation();
      workspaceTitle.textContent = "Choose a saved project";
      workspacePath.textContent = "No native process is running.";
      projectUnavailable.hidden = true;
      setStatus("neutral", "Add a local Git project", "The saved registry is empty. No repository or Codex history will be modified.");
      return;
    }

    workspaceTitle.textContent = selected.name;
    workspacePath.textContent = selected.canonicalRoot;
    projectUnavailable.hidden = !presentation.showUnavailable;
    if (presentation.showUnavailable) {
      unavailableTitle.textContent = selected.unavailableMessage ||
        "The saved repository is unavailable.";
      unavailableDetail.textContent = selected.unavailableAction ||
        "Restore the saved path, refresh availability, or remove this project.";
    }
    if (presentation.restoreTranscript) {
      restoreConversation(presentation.savedConversation);
    }
    conversation.hidden = !presentation.showConversation;
    sessionReady = presentation.mode === "ready";
    if (presentation.mode === "repository_unavailable") {
      readyRepository = null;
      turnActive = false;
    }
    setComposerReady(presentation.composerReady);
    if (
      presentation.statusKind !== null &&
      presentation.statusTitle !== null &&
      presentation.statusDetail !== null
    ) {
      setStatus(
        presentation.statusKind,
        presentation.statusTitle,
        presentation.statusDetail,
        presentation.canRetryNative,
      );
    }
  };

  const hostFailure = (result, fallback) => {
    const error = result && result.error;
    setStatus(
      "failed",
      error && error.message ? error.message : fallback,
      error && error.action ? error.action : "Retry after checking the local prerequisite.",
      true,
    );
  };

  const nonSelectedRemovalFailure = (result) => {
    const error = result && result.error;
    const message = error && error.message
      ? error.message
      : "The non-selected project could not be removed.";
    const action = error && error.action ? " " + error.action : "";
    setStatus(
      "running",
      "Codex is working",
      "The selected response is still running. " + message + action,
    );
  };

  const showSwitchConfirmation = (projectId) => {
    pendingSwitchProjectId = projectId;
    if (typeof switchDialog.showModal === "function") {
      switchDialog.showModal();
    } else {
      switchDialog.hidden = false;
    }
  };

  const closeSwitchConfirmation = () => {
    pendingSwitchProjectId = null;
    if (typeof switchDialog.close === "function") {
      switchDialog.close();
    } else {
      switchDialog.hidden = true;
    }
  };

  const chooseProject = async (projectId, confirmed = false) => {
    if (
      !nativeBindings || registryBusy ||
      projectId === registry.selectedProjectId
    ) return;
    if (turnActive && !confirmed) {
      showSwitchConfirmation(projectId);
      return;
    }
    sessionReady = false;
    setComposerReady(false);
    setRepositoryBusy(true);
    setStatus("running", "Switching project", "Stopping the prior Vantage-owned process before opening the selected workspace.");
    try {
      const result = await nativeBindings.selectProject(projectId, confirmed);
      if (result && result.ok) applyRegistry(result.snapshot);
      else hostFailure(result, "The selected project could not be opened.");
    } catch (error) {
      hostFailure({ error }, "The selected project could not be opened.");
    } finally {
      setRepositoryBusy(false);
    }
  };

  const activateCurrent = async (alreadyBusy = false) => {
    if (
      !nativeBindings || (!alreadyBusy && registryBusy) || turnActive ||
      !selectedProject()
    ) return;
    sessionReady = false;
    readyRepository = null;
    setComposerReady(false);
    if (!alreadyBusy) setRepositoryBusy(true);
    setStatus("running", "Opening selected project", "Checking its saved canonical Git root before launching Codex.");
    try {
      const result = await nativeBindings.activateSelectedProject();
      if (result && result.ok) applyRegistry(result.snapshot);
      else hostFailure(result, "The selected project could not be opened.");
    } catch (error) {
      hostFailure({ error }, "The selected project could not be opened.");
    } finally {
      if (!alreadyBusy) setRepositoryBusy(false);
    }
  };

  const refreshRegistry = async () => {
    if (!nativeBindings || registryBusy || turnActive) return;
    const previous = selectedProject();
    setRepositoryBusy(true);
    try {
      const result = await nativeBindings.refreshProjects();
      if (result && result.ok) {
        applyRegistry(result.snapshot);
        const current = selectedProject();
        if (shouldActivateAfterAvailabilityRefresh(previous, current)) {
          await activateCurrent(true);
        }
      } else hostFailure(result, "Saved projects could not be checked.");
    } catch (error) {
      hostFailure({ error }, "Saved projects could not be checked.");
    } finally {
      setRepositoryBusy(false);
    }
  };

  const makeMessage = (role, text) => {
    const article = document.createElement("article");
    article.className = "message " + role;
    const label = document.createElement("div");
    label.className = "message-role";
    label.textContent = role === "user" ? "You" : "Codex";
    const body = document.createElement(role === "user" ? "p" : "div");
    body.className = "message-body";
    body.textContent = text;
    article.append(label, body);
    let terminal = null;
    if (role === "assistant") {
      terminal = document.createElement("p");
      terminal.className = "message-terminal";
      terminal.hidden = true;
      article.append(terminal);
    }
    transcript.append(article);
    return { body, terminal, source: text };
  };

  const renderAssistant = (assistant) => {
    try {
      globalThis.vantageRenderMarkdown(assistant.body, assistant.source);
    } catch {
      assistant.body.classList.add("render-fallback");
      assistant.body.textContent = assistant.source;
    }
  };

  const restoreConversation = (saved) => {
    assistantMessages.length = 0;
    activeAssistant = null;
    transcript.replaceChildren();
    if (!saved) return;
    for (const turn of saved.turns) {
      makeMessage("user", turn.prompt);
      const assistant = makeMessage("assistant", turn.assistantSource);
      assistantMessages.push(assistant);
      renderAssistant(assistant);
      assistant.terminal.hidden = false;
      assistant.terminal.className = "message-terminal " + turn.phase;
      assistant.terminal.textContent = turn.recoveryLabel
        ? turn.terminalLabel + " · " + turn.recoveryLabel
        : turn.terminalLabel;
    }
  };

  const setTurnTerminal = (event) => {
    if (!activeAssistant) return;
    try {
      renderAssistant(activeAssistant);
    } finally {
      activeAssistant.terminal.hidden = false;
      activeAssistant.terminal.className = "message-terminal " + event.status;
      activeAssistant.terminal.textContent = event.status === "completed"
        ? "Completed"
        : event.status === "interrupted"
        ? "Interrupted"
        : "Failed";
    }
  };

  const setTurnUnresolved = (event) => {
    const projection = deriveUnresolvedTurnProjection(event.recoveryLabel);
    turnActive = projection.turnActive;
    if (activeAssistant) {
      try {
        renderAssistant(activeAssistant);
      } finally {
        activeAssistant.terminal.hidden = false;
        activeAssistant.terminal.className = projection.terminalClass;
        activeAssistant.terminal.textContent = projection.terminalText;
      }
    }
    setRepositoryBusy(registryBusy);
    setComposerReady(projection.composerReady);
  };

  const nativeErrorText = (error) => {
    if (error && typeof error.message === "string") return error.message;
    return "The native host rejected the request.";
  };

  globalThis.vantageReceiveEvent = (event) => {
    if (!event || typeof event.type !== "string") return;
    switch (event.type) {
      case "repository_ready":
        sessionReady = true;
        readyRepository = event.repository;
        conversation.hidden = false;
        setRepositoryBusy(registryBusy);
        setComposerReady(!(registry.conversation && registry.conversation.readOnly));
        retry.hidden = true;
        setStatus("neutral", "Codex is ready", "Repository validated. Ask a question.");
        promptInput.focus();
        break;
      case "turn_pending": {
        turnActive = true;
        setRepositoryBusy(registryBusy);
        makeMessage("user", event.prompt);
        const assistant = makeMessage("assistant", "");
        assistantMessages.push(assistant);
        activeAssistant = assistant;
        promptInput.value = "";
        setComposerReady(false);
        setStatus("running", "Submitting prompt", "Waiting for native Codex acceptance.");
        break;
      }
      case "turn_accepted":
        turnStop.hidden = false;
        turnStop.disabled = false;
        setStatus("running", "Codex is working", "Assistant text will appear as it arrives.");
        break;
      case "turn_interrupting":
        turnStop.hidden = false;
        turnStop.disabled = true;
        setStatus("running", "Stopping Codex", "Waiting for Codex to report the terminal state.");
        break;
      case "assistant_delta":
        if (activeAssistant && typeof event.delta === "string") {
          activeAssistant.source += event.delta;
          renderAssistant(activeAssistant);
          activeAssistant.body.scrollIntoView({ block: "nearest" });
        }
        break;
      case "turn_terminal":
        turnActive = false;
        setRepositoryBusy(registryBusy);
        setTurnTerminal(event);
        setComposerReady(event.canContinue === true);
        if (event.status === "completed") {
          setStatus("completed", "Completed", "Codex reported that the turn completed.");
        } else if (event.status === "interrupted") {
          setStatus("failed", "Interrupted", event.message || "Codex reported that the turn was interrupted.");
        } else {
          setStatus("failed", "Codex turn failed", [event.message, event.action].filter(Boolean).join(" "), event.canContinue !== true);
        }
        if (event.canContinue === true) promptInput.focus();
        break;
      case "turn_unresolved":
        setTurnUnresolved(event);
        setStatus(
          "failed",
          "Saved turn is unresolved",
          event.action,
          false,
        );
        break;
      case "session_failed":
        sessionReady = false;
        readyRepository = null;
        turnActive = false;
        setComposerReady(false);
        setRepositoryBusy(registryBusy);
        setStatus(
          "failed",
          event.message,
          event.action,
          event.canRetry !== false,
        );
        break;
    }
  };

  repositoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!nativeBindings || registryBusy || turnActive) return;
    setRepositoryBusy(true);
    setStatus("running", "Checking repository", "Vantage will save it only after canonical Git-root validation succeeds.");
    try {
      const result = await nativeBindings.addProject(repositoryInput.value);
      if (result && result.ok) {
        repositoryInput.value = "";
        applyRegistry(result.snapshot);
      } else {
        hostFailure(result, "The project could not be added.");
      }
    } catch (error) {
      hostFailure({ error }, "The project could not be added.");
    } finally {
      setRepositoryBusy(false);
    }
  });

  promptForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!sessionReady || turnActive) return;
    setComposerReady(false);
    try {
      await nativeBindings.submitPrompt(promptInput.value);
    } catch (error) {
      setComposerReady(true);
      setStatus("failed", "Prompt was not accepted", nativeErrorText(error));
    }
  });

  turnStop.addEventListener("click", async () => {
    if (!turnActive || turnStop.disabled) return;
    turnStop.disabled = true;
    try {
      await nativeBindings.stopTurn();
    } catch (error) {
      turnStop.disabled = false;
      setStatus("failed", "Stop was not accepted", nativeErrorText(error));
    }
  });

  refreshProjects.addEventListener("click", () => void refreshRegistry());
  unavailableRefresh.addEventListener("click", () => void refreshRegistry());
  workspaceRemove.addEventListener("click", () => {
    if (registryBusy) return;
    const selected = selectedProject();
    if (selected) showRemoval(selected);
  });
  removeCancel.addEventListener("click", closeRemoval);
  switchCancel.addEventListener("click", closeSwitchConfirmation);
  switchConfirm.addEventListener("click", () => {
    if (pendingSwitchProjectId === null) return;
    const projectId = pendingSwitchProjectId;
    closeSwitchConfirmation();
    void chooseProject(projectId, true);
  });
  removeConfirm.addEventListener("click", async () => {
    if (!nativeBindings || registryBusy || removalProjectId === null) return;
    const projectId = removalProjectId;
    const removalTransition = transitionProjectRemoval(
      projectId,
      registry.selectedProjectId,
      {
        sessionReady,
        turnActive,
        readyRepository,
        activeAssistant,
        assistantMessages,
        composerEnabled: !promptInput.disabled,
      },
    );
    closeRemoval();
    if (removalTransition.shouldResetConversation) {
      resetConversation();
    }
    setRepositoryBusy(true);
    if (removalTransition.removesSelectedProject) {
      setStatus("running", "Removing saved project", "Stopping the selected Vantage-owned process before forgetting Vantage metadata.");
    }
    try {
      const result = await nativeBindings.removeProject(projectId, true);
      if (result && result.ok) applyRegistry(result.snapshot);
      else if (!removalTransition.removesSelectedProject && turnActive) {
        nonSelectedRemovalFailure(result);
      } else {
        hostFailure(result, "The project could not be removed.");
      }
    } catch (error) {
      if (!removalTransition.removesSelectedProject && turnActive) {
        nonSelectedRemovalFailure({ error });
      } else {
        hostFailure({ error }, "The project could not be removed.");
      }
    } finally {
      setRepositoryBusy(false);
    }
  });

  retry.addEventListener("click", () => {
    const selected = selectedProject();
    const action = deriveRetryAction(
      appInitialized,
      selected ? selected.availability : null,
    );
    if (action === "initialize") {
      void initialize();
    } else if (action === "activate") {
      void activateCurrent();
    } else {
      void refreshRegistry();
    }
  });

  const initialize = async () => {
    setRepositoryBusy(true);
    try {
      const result = await nativeBindings.initializeApp();
      if (!result || !result.ok) {
        hostFailure(
          result,
          "Vantage could not open its saved project registry.",
        );
        return;
      }
      appInitialized = true;
      applyRegistry(result.snapshot);
      const selected = selectedProject();
      if (
        selected && selected.availability === "available" &&
        !(result.snapshot.conversation &&
          result.snapshot.conversation.readOnly)
      ) {
        await activateCurrent(true);
      }
    } catch (error) {
      hostFailure(
        { error },
        "Vantage could not open its saved project registry.",
      );
    } finally {
      setRepositoryBusy(false);
    }
  };

  setComposerReady(false);
  setRepositoryBusy(false);
  if (nativeBindings) void initialize();
})();`;
