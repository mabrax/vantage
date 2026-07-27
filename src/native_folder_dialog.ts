import { VantageError } from "./errors.ts";

/**
 * The desktop runtime does not currently expose a first-class native folder
 * picker. Keep the platform-specific boundary small so another host API can
 * replace it without changing the registry or UI contracts.
 */
export interface NativeFolderDialogOutput {
  readonly success: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export type NativeFolderDialogRunner = (
  command: string,
  options: Deno.CommandOptions,
) => Promise<NativeFolderDialogOutput>;

export const MACOS_OSASCRIPT_PATH = "/usr/bin/osascript";

const runCommand: NativeFolderDialogRunner = async (command, options) => {
  return await new Deno.Command(command, options).output();
};

export const MACOS_FOLDER_CHOOSER_SCRIPT = [
  "try",
  '  set selectedFolder to choose folder with prompt "Choose a local Git repository"',
  "  POSIX path of selectedFolder",
  "on error number -128",
  '  return ""',
  "end try",
].join("\n");

export async function chooseLocalRepositoryDirectory(
  runner: NativeFolderDialogRunner = runCommand,
  platform: string = Deno.build.os,
): Promise<string | null> {
  if (platform !== "darwin") {
    throw chooserError(
      "The native folder chooser is available only on macOS in this build.",
    );
  }

  let output: NativeFolderDialogOutput;
  try {
    output = await runner(MACOS_OSASCRIPT_PATH, {
      args: ["-e", MACOS_FOLDER_CHOOSER_SCRIPT],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
  } catch {
    throw chooserError("Vantage could not start the native folder chooser.");
  }

  if (!output.success) {
    throw chooserError("Vantage could not open the native folder chooser.");
  }

  const selectedPath = new TextDecoder().decode(output.stdout)
    .replace(/[\r\n]+$/, "");
  return selectedPath.length === 0 ? null : selectedPath;
}

function chooserError(message: string): VantageError {
  return new VantageError(
    "invalid_command",
    message,
    "Retry choosing an accessible local Git repository folder. Codex has not been started.",
  );
}
