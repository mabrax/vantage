import {
  ContractError,
  loadConfiguration,
  type LoadedConfiguration,
} from "./config.ts";

export type PreflightDiagnosticCode =
  | "DENO_VERSION_MISMATCH"
  | "CODEX_NOT_FOUND"
  | "CODEX_VERSION_MISMATCH"
  | "CODEX_AUTH_REQUIRED"
  | "ARTIFACT_MISMATCH"
  | "PLATFORM_UNSUPPORTED";

export type PreflightDiagnostic = {
  code: PreflightDiagnosticCode;
  stage: string;
  expected: unknown;
  observed: unknown;
  platform: { os: string; arch: string };
  executablePath?: string;
  nextAction: string;
};

export class PreflightError extends Error {
  constructor(public readonly diagnostic: PreflightDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.stage}`);
    this.name = "PreflightError";
  }

  get code(): PreflightDiagnosticCode {
    return this.diagnostic.code;
  }
}

export type PlatformProbe = { os: string; arch: string };

export type CodexVersionProbe = (
  executable: string,
) => Promise<{ output: string; executablePath?: string }>;

export type StaticPreflightOptions = {
  mode?: "deterministic" | "spike:verify" | "spike:accept";
  denoVersion?: string;
  codexExecutable?: string;
  platform?: PlatformProbe;
  probeCodexVersion?: CodexVersionProbe;
  verifyArtifacts?: () => Promise<LoadedConfiguration>;
};

const EXPECTED_DENO = "2.9.3";
const EXPECTED_CODEX_OUTPUT = "codex-cli 0.145.0";

function fail(
  code: PreflightDiagnosticCode,
  stage: string,
  expected: unknown,
  observed: unknown,
  nextAction: string,
  platform: PlatformProbe,
  executablePath?: string,
): never {
  throw new PreflightError({
    code,
    stage,
    expected,
    observed,
    platform,
    ...(executablePath === undefined ? {} : { executablePath }),
    nextAction,
  });
}

async function defaultCodexVersionProbe(
  executable: string,
): Promise<{ output: string; executablePath?: string }> {
  const command = new Deno.Command(executable, {
    args: ["--version"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const decoded = new TextDecoder().decode(output.stdout).trim();
  if (!output.success) {
    throw new Error(`codex --version exited ${output.code}`);
  }
  return { output: decoded, executablePath: executable };
}

export async function runStaticPreflight(
  options: StaticPreflightOptions = {},
): Promise<{
  configuration: LoadedConfiguration;
  codexExecutable: string;
  codexVersionOutput: typeof EXPECTED_CODEX_OUTPUT;
  platform: PlatformProbe;
}> {
  const platform = options.platform ?? {
    os: Deno.build.os,
    arch: Deno.build.arch,
  };
  const denoVersion = options.denoVersion ?? Deno.version.deno;
  if (denoVersion !== EXPECTED_DENO) {
    fail(
      "DENO_VERSION_MISMATCH",
      "preflight.deno",
      EXPECTED_DENO,
      denoVersion,
      "install Deno 2.9.3 and rerun the repository-owned task",
      platform,
      Deno.execPath(),
    );
  }

  let configuration: LoadedConfiguration;
  try {
    configuration = await (options.verifyArtifacts ?? loadConfiguration)();
  } catch (error) {
    fail(
      "ARTIFACT_MISMATCH",
      "preflight.artifacts",
      "the immutable manifest, generated bundle, and baseline coverage agree",
      error instanceof ContractError
        ? { code: error.code, details: error.details }
        : { errorType: error instanceof Error ? error.name : typeof error },
      "run the read-only protocol verification task and restore the pinned generated inputs",
      platform,
    );
  }

  const liveMode = options.mode === "spike:verify" ||
    options.mode === "spike:accept";
  if (
    liveMode &&
    (platform.os !== configuration.compatibility.validationPlatform.os ||
      platform.arch !== configuration.compatibility.validationPlatform.arch)
  ) {
    fail(
      "PLATFORM_UNSUPPORTED",
      "preflight.platform",
      configuration.compatibility.validationPlatform,
      platform,
      "run the live compatibility task on the manifest-selected platform",
      platform,
    );
  }

  const codexExecutable = options.codexExecutable ?? "codex";
  let codexVersion: { output: string; executablePath?: string };
  try {
    codexVersion = await (options.probeCodexVersion ??
      defaultCodexVersionProbe)(codexExecutable);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      fail(
        "CODEX_NOT_FOUND",
        "preflight.codex.resolve",
        EXPECTED_CODEX_OUTPUT,
        { executable: codexExecutable, found: false },
        "install Codex CLI 0.145.0 or pass its exact executable path",
        platform,
        codexExecutable,
      );
    }
    fail(
      "CODEX_VERSION_MISMATCH",
      "preflight.codex.version",
      EXPECTED_CODEX_OUTPUT,
      { errorType: error instanceof Error ? error.name : typeof error },
      "verify the selected Codex executable runs and reports the exact pinned version",
      platform,
      codexExecutable,
    );
  }
  if (codexVersion.output !== EXPECTED_CODEX_OUTPUT) {
    fail(
      "CODEX_VERSION_MISMATCH",
      "preflight.codex.version",
      EXPECTED_CODEX_OUTPUT,
      codexVersion.output,
      "select Codex CLI 0.145.0 and rerun the compatibility task",
      platform,
      codexVersion.executablePath ?? codexExecutable,
    );
  }

  return {
    configuration,
    codexExecutable,
    codexVersionOutput: EXPECTED_CODEX_OUTPUT,
    platform,
  };
}

export function requireAuthenticatedAccount(
  result: unknown,
  platform: PlatformProbe = {
    os: Deno.build.os,
    arch: Deno.build.arch,
  },
): Record<string, unknown> {
  const record = result !== null && typeof result === "object"
    ? result as Record<string, unknown>
    : {};
  const account = record.account;
  if (account === null || account === undefined) {
    fail(
      "CODEX_AUTH_REQUIRED",
      "preflight.account",
      { account: "non-null" },
      {
        account: account ?? null,
        requiresOpenaiAuth: record.requiresOpenaiAuth,
      },
      "authenticate the caller-selected CODEX_HOME before running live compatibility",
      platform,
    );
  }
  if (typeof account !== "object") {
    fail(
      "CODEX_AUTH_REQUIRED",
      "preflight.account",
      { account: "non-null object" },
      { accountType: typeof account },
      "use an account/read response from the pinned app-server",
      platform,
    );
  }
  return account as Record<string, unknown>;
}
