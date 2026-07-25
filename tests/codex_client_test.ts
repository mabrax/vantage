import assert from "node:assert/strict";
import {
  AppServerCodexSession,
  resolveCodexExecutable,
} from "../src/codex_client.ts";
import { VantageError } from "../src/errors.ts";

Deno.test("a missing Codex executable is classified as actionable", () => {
  assert.throws(
    () =>
      new AppServerCodexSession("/repo", () => {
        throw new Deno.errors.NotFound("missing");
      }),
    (error) =>
      error instanceof VantageError &&
      error.code === "codex_missing" &&
      error.action.includes("PATH"),
  );
});

Deno.test("Codex resolution finds the primary macOS installation outside a GUI PATH", () => {
  const originalPath = Deno.env.get("PATH");
  try {
    Deno.env.set("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    const executable = resolveCodexExecutable();
    if (
      Deno.build.os === "darwin" &&
      Deno.statSync("/opt/homebrew/bin/codex").isFile
    ) {
      assert.equal(executable, "/opt/homebrew/bin/codex");
    } else {
      assert.equal(executable, "codex");
    }
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
  }
});
