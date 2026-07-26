import assert from "node:assert/strict";
import {
  CSS,
  deriveConversationPresentation,
  deriveRetryAction,
  deriveUnresolvedTurnProjection,
  HTML,
  JAVASCRIPT,
  projectRemovalDetail,
  shouldActivateAfterAvailabilityRefresh,
  transitionProjectRemoval,
} from "../src/ui.ts";

Deno.test("saved-project sidebar exposes the complete empty, unavailable, selection, and removal surface", () => {
  for (
    const id of [
      "project-empty",
      "project-list",
      "repository-form",
      "workspace-empty",
      "project-unavailable",
      "workspace-remove",
      "remove-dialog",
      "remove-detail",
      "remove-cancel",
      "remove-confirm",
    ]
  ) {
    assert.match(HTML, new RegExp(`id="${id}"`));
  }
  assert.match(HTML, /Add your first local Git repository/);
  assert.match(HTML, /one durable native Codex conversation/i);
  assert.match(HTML, /Remove from Vantage/);
  assert.match(CSS, /\.app-shell \{[\s\S]*grid-template-columns: 300px/);
  assert.match(CSS, /\.project-item\.selected/);
  assert.match(CSS, /\.unavailable-panel/);
});

Deno.test("sidebar commands render host snapshots with text-only project identity and explicit confirmation", () => {
  assert.doesNotThrow(() => new Function(JAVASCRIPT));
  assert.match(JAVASCRIPT, /name\.textContent = project\.name/);
  assert.match(JAVASCRIPT, /path\.textContent = project\.canonicalRoot/);
  assert.match(
    JAVASCRIPT,
    /nativeBindings\.addProject\(repositoryInput\.value\)/,
  );
  assert.match(
    JAVASCRIPT,
    /nativeBindings\.selectProject\(projectId, confirmed\)/,
  );
  assert.match(JAVASCRIPT, /nativeBindings\.removeProject\(projectId, true\)/);
  assert.match(JAVASCRIPT, /removeDetail\.textContent = projectRemovalDetail/);
  assert.match(JAVASCRIPT, /typeof removeDialog\.showModal === "function"/);
  assert.match(
    JAVASCRIPT,
    /removeCancel\.addEventListener\("click", closeRemoval\)/,
  );
  assert.equal(JAVASCRIPT.includes("innerHTML"), false);
  assert.equal(JAVASCRIPT.includes("outerHTML"), false);
});

Deno.test("startup recovery retries initialization and removal copy matches process ownership", () => {
  assert.equal(deriveRetryAction(false, null), "initialize");
  assert.equal(deriveRetryAction(false, "available"), "initialize");
  assert.equal(deriveRetryAction(true, "available"), "activate");
  assert.equal(deriveRetryAction(true, "missing"), "refresh");
  assert.match(JAVASCRIPT, /if \(action === "initialize"\)/);
  assert.match(JAVASCRIPT, /appInitialized = true/);

  const selected = projectRemovalDetail(true);
  assert.match(selected, /stop this project's selected app-server process/i);
  assert.match(
    selected,
    /repository and Codex-owned native history remain untouched/i,
  );
  assert.match(
    selected,
    /Re-adding this path later creates a fresh Vantage project/i,
  );

  const nonSelected = projectRemovalDetail(false);
  assert.match(
    nonSelected,
    /keep the selected project's app-server and conversation running/i,
  );
  assert.doesNotMatch(nonSelected, /stop this project's selected app-server/i);
  assert.match(nonSelected, /forgetting only this project's Vantage-owned/i);
});

Deno.test("read-only and idle composer states do not expose a meaningless Stop action", () => {
  assert.match(
    JAVASCRIPT,
    /turnStop\.hidden = ready \|\| !turnActive/,
  );
  assert.match(
    JAVASCRIPT,
    /turnStop\.disabled = ready \|\| !turnActive/,
  );
});

Deno.test("unavailable project presentation preserves rich saved history read-only until exact readiness", () => {
  const richConversation = {
    readOnly: false,
    nativeResumeFailure: null,
    nativeThreadId: "saved-native-id",
    nativeResumeState: "resumable",
    turns: [{
      prompt: "literal **prompt**",
      assistantSource:
        '```mermaid\ngraph LR\n  Saved --> Restored\n```\n```svg\n<svg viewBox="0 0 1 1"></svg>\n```',
      phase: "completed",
      terminalLabel: "Completed",
      recoveryLabel: null,
    }],
  };
  const unavailable = deriveConversationPresentation(
    {
      canonicalRoot: "/exact/repository",
      availability: "missing",
      unavailableMessage: "The saved repository is missing or has moved.",
      unavailableAction:
        "Restore it at the exact saved path, or remove and re-add the project.",
    },
    richConversation,
    null,
    true,
  );

  assert.equal(unavailable.mode, "repository_unavailable");
  assert.strictEqual(unavailable.savedConversation, richConversation);
  assert.equal(unavailable.showUnavailable, true);
  assert.equal(unavailable.showConversation, true);
  assert.equal(unavailable.restoreTranscript, true);
  assert.equal(unavailable.composerReady, false);
  assert.equal(unavailable.canRetryNative, false);
  assert.match(unavailable.statusTitle ?? "", /saved history is read-only/i);
  assert.match(unavailable.statusDetail ?? "", /exact canonical root/i);
  assert.equal(richConversation.nativeResumeState, "resumable");
  assert.equal(richConversation.nativeThreadId, "saved-native-id");

  const opening = deriveConversationPresentation(
    {
      canonicalRoot: "/exact/repository",
      availability: "available",
      unavailableMessage: null,
      unavailableAction: null,
    },
    richConversation,
    null,
    false,
  );
  assert.equal(opening.mode, "opening");
  assert.strictEqual(opening.savedConversation, richConversation);
  assert.equal(opening.showConversation, true);
  assert.equal(opening.composerReady, false);

  const ready = deriveConversationPresentation(
    {
      canonicalRoot: "/exact/repository",
      availability: "available",
      unavailableMessage: null,
      unavailableAction: null,
    },
    richConversation,
    "/exact/repository",
    false,
  );
  assert.equal(ready.mode, "ready");
  assert.equal(ready.showConversation, true);
  assert.equal(ready.composerReady, true);
});

Deno.test("unresolved recovery and native resume failure expose distinct actions", () => {
  const project = {
    canonicalRoot: "/exact/repository",
    availability: "available",
    unavailableMessage: null,
    unavailableAction: null,
  };
  const unresolved = deriveConversationPresentation(
    project,
    {
      readOnly: true,
      nativeResumeFailure: null,
      turns: [{ phase: "streaming", recoveryLabel: "Incomplete" }],
    },
    null,
    false,
  );
  assert.equal(unresolved.mode, "recovered_unresolved");
  assert.equal(unresolved.canRetryNative, false);
  assert.match(unresolved.statusDetail ?? "", /no reconciliation retry/i);
  assert.doesNotMatch(
    unresolved.statusDetail ?? "",
    /retry (the )?exact native/i,
  );

  const nativeFailure = deriveConversationPresentation(
    project,
    {
      readOnly: true,
      nativeResumeFailure: "missing",
      turns: [{ phase: "completed", terminalLabel: "Completed" }],
    },
    null,
    false,
  );
  assert.equal(nativeFailure.mode, "native_non_resumable");
  assert.equal(nativeFailure.canRetryNative, true);
  assert.match(nativeFailure.statusDetail ?? "", /exact saved native ID/i);
  assert.match(
    nativeFailure.statusDetail ?? "",
    /will not start a replacement/i,
  );
});

Deno.test("availability refresh activates only the same restored project identity", () => {
  const unavailable = {
    id: "project",
    canonicalRoot: "/exact/repository",
    availability: "missing",
  };
  assert.equal(
    shouldActivateAfterAvailabilityRefresh(unavailable, {
      ...unavailable,
      availability: "available",
    }),
    true,
  );
  assert.equal(
    shouldActivateAfterAvailabilityRefresh(unavailable, {
      id: "replacement",
      canonicalRoot: "/exact/repository",
      availability: "available",
    }),
    false,
  );
  assert.equal(
    shouldActivateAfterAvailabilityRefresh(unavailable, {
      id: "project",
      canonicalRoot: "/retargeted/repository",
      availability: "available",
    }),
    false,
  );
});

Deno.test("active recovered turn projects Unresolved without enabling continuation", () => {
  const projection = deriveUnresolvedTurnProjection(
    "Codex accepted this turn, but no terminal outcome was proven.",
  );
  assert.deepEqual(projection, {
    turnActive: false,
    composerReady: false,
    terminalClass: "message-terminal unresolved",
    terminalText:
      "Unresolved · Codex accepted this turn, but no terminal outcome was proven.",
  });
  assert.doesNotMatch(projection.terminalText, /Failed/);
  assert.match(CSS, /\.message-terminal\.unresolved/);
});

Deno.test("registry busy state guards and disables every competing project mutation without blocking active-turn removal", () => {
  assert.match(JAVASCRIPT, /let registryBusy = false/);
  assert.match(
    JAVASCRIPT,
    /repositoryInput\.disabled = busy \|\| turnActive/,
  );
  assert.match(
    JAVASCRIPT,
    /select\.disabled = registryBusy/,
  );
  assert.match(JAVASCRIPT, /remove\.disabled = registryBusy/);
  assert.match(JAVASCRIPT, /workspaceRemove\.disabled = busy/);
  assert.match(JAVASCRIPT, /removeConfirm\.disabled = busy/);
  assert.match(
    JAVASCRIPT,
    /!nativeBindings \|\| registryBusy \|\| removalProjectId === null/,
  );
  assert.equal(
    JAVASCRIPT.includes(
      "!nativeBindings || registryBusy || turnActive || removalProjectId",
    ),
    false,
  );
  assert.match(
    JAVASCRIPT,
    /finally \{\s+setRepositoryBusy\(false\);\s+\}/,
  );
});

Deno.test("non-selected removal preserves the selected active-turn projection while selected removal resets it", () => {
  const activeAssistant = { source: "partial selected response" };
  const assistantMessages = [activeAssistant];
  const state = {
    sessionReady: true,
    turnActive: true,
    readyRepository: "/selected",
    activeAssistant,
    assistantMessages,
    composerEnabled: false,
  };

  const nonSelected = transitionProjectRemoval(
    "project-other",
    "project-selected",
    state,
  );
  assert.deepEqual(nonSelected, {
    ...state,
    removesSelectedProject: false,
    shouldResetConversation: false,
  });
  assert.strictEqual(nonSelected.activeAssistant, activeAssistant);
  assert.strictEqual(nonSelected.assistantMessages, assistantMessages);

  const selected = transitionProjectRemoval(
    "project-selected",
    "project-selected",
    state,
  );
  assert.deepEqual(selected, {
    sessionReady: false,
    turnActive: false,
    readyRepository: null,
    activeAssistant: null,
    assistantMessages: [],
    composerEnabled: false,
    removesSelectedProject: true,
    shouldResetConversation: true,
  });
});
