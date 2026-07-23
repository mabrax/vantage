const suites = [
  {
    task: "test:transport",
    files: [
      "spikes/codex-app-server/tests/jsonl_client_test.ts",
      "spikes/codex-app-server/tests/protocol_validation_test.ts",
    ],
  },
  {
    task: "test:lifecycle",
    files: [
      "spikes/codex-app-server/tests/preflight_test.ts",
      "spikes/codex-app-server/tests/transcript_test.ts",
    ],
  },
  {
    task: "test:shutdown",
    files: ["spikes/codex-app-server/tests/shutdown_test.ts"],
  },
] as const;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

for (const suite of suites) {
  const ready = (await Promise.all(suite.files.map(isFile))).every(Boolean);
  if (!ready) {
    console.log(`Skipping ${suite.task}: phase files not present`);
    continue;
  }
  const denoCommand = Deno.execPath().split("/").at(-1)!;
  const child = new Deno.Command(denoCommand, {
    args: ["task", suite.task],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  if (!status.success) Deno.exit(status.code);
}
