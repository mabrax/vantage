import assert from "node:assert/strict";
import { CSS, HTML, JAVASCRIPT } from "../src/ui.ts";

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
      "remove-cancel",
      "remove-confirm",
    ]
  ) {
    assert.match(HTML, new RegExp(`id="${id}"`));
  }
  assert.match(HTML, /Add your first local Git repository/);
  assert.match(HTML, /conversation history is not saved in this step/i);
  assert.match(
    HTML,
    /Re-adding this path later creates a fresh Vantage project/i,
  );
  assert.match(
    HTML,
    /repository and Codex-owned native history remain untouched/i,
  );
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
  assert.match(JAVASCRIPT, /nativeBindings\.selectProject\(projectId\)/);
  assert.match(JAVASCRIPT, /nativeBindings\.removeProject\(projectId, true\)/);
  assert.match(JAVASCRIPT, /typeof removeDialog\.showModal === "function"/);
  assert.match(
    JAVASCRIPT,
    /removeCancel\.addEventListener\("click", closeRemoval\)/,
  );
  assert.equal(JAVASCRIPT.includes("innerHTML"), false);
  assert.equal(JAVASCRIPT.includes("outerHTML"), false);
});
