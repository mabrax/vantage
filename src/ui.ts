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
          <h1>Ask one repository-aware question.</h1>
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
            <p>One prompt, streamed from a real native Codex turn.</p>
          </div>
        </div>
        <div id="transcript" class="transcript" aria-live="polite"></div>
        <form id="prompt-form">
          <label for="prompt">Question</label>
          <textarea id="prompt" name="prompt" rows="4" maxlength="32000" placeholder="What does this repository do, based on its source?" required></textarea>
          <div class="composer-footer">
            <span class="policy">Read-only · existing Codex defaults</span>
            <button id="prompt-submit" type="submit">Ask Codex</button>
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
.transcript { display: grid; gap: 14px; margin-bottom: 18px; }
.message { border-left: 2px solid #2b3a45; padding: 4px 0 4px 15px; }
.message.user { border-color: #567564; }
.message-role { margin-bottom: 6px; color: #788894; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.message-body { margin: 0; color: #dfe6ec; line-height: 1.62; white-space: pre-wrap; overflow-wrap: anywhere; }
.message.assistant .message-body:empty::after { content: "Waiting for Codex…"; color: #6f7c86; font-style: italic; }

.composer-footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 10px; }
.composer-footer button { min-height: 42px; }
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

export const JAVASCRIPT = `(() => {
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
  const transcript = document.querySelector("#transcript");
  const status = document.querySelector("#status");
  const statusTitle = document.querySelector("#status-title");
  const statusDetail = document.querySelector("#status-detail");
  const retry = document.querySelector("#retry");

  let assistantBody = null;
  let sessionReady = false;
  let promptUsed = false;

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

  const makeMessage = (role, text) => {
    const article = document.createElement("article");
    article.className = "message " + role;
    const label = document.createElement("div");
    label.className = "message-role";
    label.textContent = role === "user" ? "You" : "Codex";
    const body = document.createElement("p");
    body.className = "message-body";
    body.textContent = text;
    article.append(label, body);
    transcript.append(article);
    return body;
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
        promptInput.disabled = false;
        promptSubmit.disabled = false;
        retry.hidden = true;
        setStatus("neutral", "Codex is ready", "Repository validated. Ask one question.");
        promptInput.focus();
        break;
      case "turn_pending":
        promptUsed = true;
        makeMessage("user", event.prompt);
        assistantBody = makeMessage("assistant", "");
        promptInput.disabled = true;
        promptSubmit.disabled = true;
        setStatus("running", "Submitting prompt", "Waiting for native Codex acceptance.");
        break;
      case "turn_accepted":
        setStatus("running", "Codex is working", "Assistant text will appear as it arrives.");
        break;
      case "assistant_delta":
        if (assistantBody && typeof event.delta === "string") {
          assistantBody.textContent += event.delta;
          assistantBody.scrollIntoView({ block: "nearest" });
        }
        break;
      case "turn_terminal":
        promptInput.disabled = true;
        promptSubmit.disabled = true;
        if (event.status === "completed") {
          setStatus("completed", "Completed", "Codex reported that the turn completed.");
        } else if (event.status === "interrupted") {
          setStatus("failed", "Interrupted", event.message || "Codex reported that the turn was interrupted.", true);
        } else {
          setStatus("failed", "Codex turn failed", [event.message, event.action].filter(Boolean).join(" "), true);
        }
        break;
      case "session_failed":
        sessionReady = false;
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
    if (!sessionReady || promptUsed) return;
    promptInput.disabled = true;
    promptSubmit.disabled = true;
    try {
      await bindings.submitPrompt(promptInput.value);
    } catch (error) {
      setStatus("failed", "Prompt was not accepted", nativeErrorText(error), true);
    }
  });

  retry.addEventListener("click", () => {
    sessionReady = false;
    promptUsed = false;
    assistantBody = null;
    transcript.replaceChildren();
    conversation.hidden = true;
    repositoryResult.hidden = true;
    repositoryInput.disabled = false;
    repositorySubmit.disabled = false;
    repositoryInput.focus();
    setStatus("neutral", "Try again", "Correct the prerequisite or path, then retry.");
  });
})();`;
