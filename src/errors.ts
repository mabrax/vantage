export type VantageErrorCode =
  | "repository"
  | "codex_missing"
  | "authentication"
  | "codex_start"
  | "turn"
  | "closed"
  | "invalid_command";

export class VantageError extends Error {
  constructor(
    readonly code: VantageErrorCode,
    message: string,
    readonly action: string,
  ) {
    super(message);
    this.name = "VantageError";
  }
}

export function asVantageError(error: unknown): VantageError {
  if (error instanceof VantageError) return error;
  return new VantageError(
    "codex_start",
    "Codex stopped unexpectedly.",
    "Check your local Codex installation, then retry.",
  );
}
