import assert from "node:assert/strict";
import {
  chooseLocalRepositoryDirectory,
  MACOS_FOLDER_CHOOSER_SCRIPT,
  MACOS_OSASCRIPT_PATH,
  type NativeFolderDialogRunner,
} from "../src/native_folder_dialog.ts";
import { VantageError } from "../src/errors.ts";

function output(
  success: boolean,
  stdout = "",
): Awaited<ReturnType<NativeFolderDialogRunner>> {
  return {
    success,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
  };
}

Deno.test("native folder chooser returns the selected POSIX directory", async () => {
  let command = "";
  let args: readonly string[] = [];
  const runner: NativeFolderDialogRunner = (invokedCommand, options) => {
    command = invokedCommand;
    args = options.args ?? [];
    return Promise.resolve(output(true, "/Users/example/project\n"));
  };

  const selected = await chooseLocalRepositoryDirectory(runner, "darwin");

  assert.equal(selected, "/Users/example/project");
  assert.equal(command, MACOS_OSASCRIPT_PATH);
  assert.deepEqual(args.slice(0, 1), ["-e"]);
  assert.equal(args[1], MACOS_FOLDER_CHOOSER_SCRIPT);
  assert.match(MACOS_FOLDER_CHOOSER_SCRIPT, /choose folder/);
});

Deno.test("native folder chooser maps user cancellation to a silent null result", async () => {
  const selected = await chooseLocalRepositoryDirectory(
    () => Promise.resolve(output(true)),
    "darwin",
  );

  assert.equal(selected, null);
});

Deno.test("native folder chooser exposes host launch failures as actionable errors", async () => {
  await assert.rejects(
    () =>
      chooseLocalRepositoryDirectory(
        () => Promise.reject(new Error("osascript unavailable")),
        "darwin",
      ),
    (error) =>
      error instanceof VantageError &&
      error.code === "invalid_command" &&
      /native folder chooser/i.test(error.message) &&
      /retry choosing an accessible local Git repository folder/i.test(
        error.action,
      ),
  );

  await assert.rejects(
    () =>
      chooseLocalRepositoryDirectory(
        () => Promise.resolve(output(false)),
        "darwin",
      ),
    (error) =>
      error instanceof VantageError && error.code === "invalid_command",
  );
});

Deno.test("native folder chooser reports the explicit platform limitation", async () => {
  await assert.rejects(
    () =>
      chooseLocalRepositoryDirectory(
        () => Promise.resolve(output(true)),
        "linux",
      ),
    (error) =>
      error instanceof VantageError &&
      /only on macOS/i.test(error.message) &&
      /retry choosing an accessible local Git repository folder/i.test(
        error.action,
      ),
  );
});
