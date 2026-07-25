import { VantageError } from "./errors.ts";

export interface CommandResult {
  readonly success: boolean;
  readonly stdout: Uint8Array;
}

export type CommandRunner = (
  command: string,
  options: Deno.CommandOptions,
) => Promise<CommandResult>;

const runCommand: CommandRunner = async (command, options) => {
  return await new Deno.Command(command, options).output();
};

export async function validateRepository(
  input: unknown,
  runner: CommandRunner = runCommand,
): Promise<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw repositoryError("Enter a local Git repository path.");
  }

  let candidate: string;
  try {
    candidate = await Deno.realPath(input.trim());
    if (!(await Deno.stat(candidate)).isDirectory) {
      throw new Error("not a directory");
    }
  } catch {
    throw repositoryError("That path is not an accessible directory.");
  }

  let result: CommandResult;
  try {
    result = await runner("git", {
      args: ["-C", candidate, "rev-parse", "--show-toplevel"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    });
  } catch {
    throw repositoryError(
      "Git is unavailable, so the repository cannot be validated.",
    );
  }

  const root = new TextDecoder().decode(result.stdout).trim();
  if (!result.success || root.length === 0) {
    throw repositoryError("That directory is not inside a Git repository.");
  }

  try {
    return await Deno.realPath(root);
  } catch {
    throw repositoryError("The Git repository root is not accessible.");
  }
}

function repositoryError(message: string): VantageError {
  return new VantageError(
    "repository",
    message,
    "Correct the path and try again. Codex has not been started.",
  );
}
