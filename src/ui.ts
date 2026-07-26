import { MARKDOWN_JAVASCRIPT } from "./markdown.ts";

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
    <main>
      <header class="brand">
        <div class="mark" aria-hidden="true">V</div>
        <div>
          <p class="eyebrow">Vantage · local Codex workspace</p>
          <h1>Talk with Codex about one repository.</h1>
          <p class="lede">Your repository stays local. Vantage uses your existing Codex installation with read-only access.</p>
        </div>
      </header>

      <section class="panel" aria-labelledby="repository-heading">
        <div class="section-heading">
          <span class="step">01</span>
          <div>
            <h2 id="repository-heading">Choose a Git repository</h2>
            <p id="repository-help">Paste an accessible local path. Vantage validates it before starting Codex.</p>
          </div>
        </div>
        <form id="repository-form">
          <label for="repository-path">Local repository path</label>
          <div class="input-row">
            <input id="repository-path" name="repository" type="text" autocomplete="off" spellcheck="false" aria-describedby="repository-help" placeholder="/Users/you/code/project" required>
            <button id="repository-submit" type="submit">Use repository</button>
          </div>
        </form>
        <div id="repository-result" class="repository-result" hidden>
          <span class="repo-dot" aria-hidden="true"></span>
          <span id="repository-name"></span>
        </div>
      </section>

      <section id="conversation" class="panel conversation" aria-labelledby="conversation-heading" hidden>
        <div class="section-heading">
          <span class="step">02</span>
          <div>
            <h2 id="conversation-heading">Ask Codex</h2>
            <p>Continue one native conversation while Vantage remains open.</p>
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
          <strong id="status-title">Choose a repository</strong>
          <p id="status-detail">No native process is running.</p>
        </div>
        <button id="retry" class="secondary" type="button" hidden>Retry</button>
      </section>
    </main>
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

main {
  width: min(920px, calc(100% - 64px));
  margin: 0 auto;
  padding: 54px 0 44px;
}

.brand {
  display: grid;
  grid-template-columns: 52px 1fr;
  gap: 18px;
  align-items: start;
  margin-bottom: 34px;
}

.mark {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border: 1px solid #6b9b88;
  border-radius: 14px;
  background: linear-gradient(145deg, #244338, #13241f);
  color: #b9ecd7;
  font-size: 23px;
  font-weight: 700;
  box-shadow: 0 16px 45px rgba(0, 0, 0, 0.25);
}

h1, h2, p { margin-top: 0; }
h1 { margin-bottom: 10px; font-size: clamp(28px, 4vw, 42px); letter-spacing: -0.035em; }
h2 { margin-bottom: 6px; font-size: 18px; letter-spacing: -0.01em; }

.eyebrow {
  margin-bottom: 9px;
  color: #83b6a1;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.lede, .section-heading p, .status p {
  color: #91a0ad;
  line-height: 1.55;
}

.lede { max-width: 660px; margin-bottom: 0; }

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

@media (max-width: 740px) {
  body { min-width: 0; }
  main { width: min(100% - 28px, 920px); padding-top: 30px; }
  .input-row { grid-template-columns: 1fr; }
  .input-row button { min-height: 44px; }
  .status { grid-template-columns: 12px 1fr; }
  .status button { grid-column: 2; justify-self: start; min-height: 36px; }
}`;

export const JAVASCRIPT = MARKDOWN_JAVASCRIPT + `(() => {
  "use strict";

  const repositoryForm = document.querySelector("#repository-form");
  const repositoryInput = document.querySelector("#repository-path");
  const repositorySubmit = document.querySelector("#repository-submit");
  const repositoryResult = document.querySelector("#repository-result");
  const repositoryName = document.querySelector("#repository-name");
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

  const assistantMessages = [];
  let activeAssistant = null;
  let sessionReady = false;
  let turnActive = false;

  const setStatus = (kind, title, detail, canRetry = false) => {
    status.className = "status " + kind;
    statusTitle.textContent = title;
    statusDetail.textContent = detail;
    retry.hidden = !canRetry;
  };

  const setRepositoryBusy = (busy) => {
    repositoryInput.disabled = busy || sessionReady;
    repositorySubmit.disabled = busy || sessionReady;
  };

  const setComposerReady = (ready) => {
    promptInput.disabled = !ready;
    promptSubmit.disabled = !ready;
    turnStop.hidden = ready;
    turnStop.disabled = ready;
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

  const nativeErrorText = (error) => {
    if (error && typeof error.message === "string") return error.message;
    return "The native host rejected the request.";
  };

  globalThis.vantageReceiveEvent = (event) => {
    if (!event || typeof event.type !== "string") return;
    switch (event.type) {
      case "repository_ready":
        sessionReady = true;
        repositoryName.textContent = event.repository;
        repositoryResult.hidden = false;
        conversation.hidden = false;
        setRepositoryBusy(false);
        setComposerReady(true);
        retry.hidden = true;
        setStatus("neutral", "Codex is ready", "Repository validated. Ask a question.");
        promptInput.focus();
        break;
      case "turn_pending": {
        turnActive = true;
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
      case "session_failed":
        sessionReady = false;
        turnActive = false;
        setComposerReady(false);
        setRepositoryBusy(false);
        setStatus("failed", event.message, event.action, true);
        break;
    }
  };

  repositoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setRepositoryBusy(true);
    setStatus("running", "Checking repository", "Codex will start only after Git validation succeeds.");
    try {
      await bindings.startSession(repositoryInput.value);
    } catch (error) {
      setRepositoryBusy(false);
      setStatus("failed", "Session could not start", nativeErrorText(error), true);
    }
  });

  promptForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!sessionReady || turnActive) return;
    setComposerReady(false);
    try {
      await bindings.submitPrompt(promptInput.value);
    } catch (error) {
      setComposerReady(true);
      setStatus("failed", "Prompt was not accepted", nativeErrorText(error));
    }
  });

  turnStop.addEventListener("click", async () => {
    if (!turnActive || turnStop.disabled) return;
    turnStop.disabled = true;
    try {
      await bindings.stopTurn();
    } catch (error) {
      turnStop.disabled = false;
      setStatus("failed", "Stop was not accepted", nativeErrorText(error));
    }
  });

  retry.addEventListener("click", () => {
    sessionReady = false;
    turnActive = false;
    assistantMessages.length = 0;
    activeAssistant = null;
    transcript.replaceChildren();
    conversation.hidden = true;
    repositoryResult.hidden = true;
    setComposerReady(false);
    repositoryInput.disabled = false;
    repositorySubmit.disabled = false;
    repositoryInput.focus();
    setStatus("neutral", "Try again", "Correct the prerequisite or path, then retry.");
  });
})();`;
