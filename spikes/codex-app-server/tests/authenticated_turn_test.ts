import { runVerifyOnly } from "../src/main.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "values differ",
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
}

const enabled = Deno.env.get("VANTAGE_RUN_AUTHENTICATED_TEST") === "1";

Deno.test({
  name:
    "authenticated: pinned Codex completes one schema-valid turn and bounded observed-tree shutdown",
  ignore: !enabled,
  async fn() {
    const candidate = await runVerifyOnly();
    const { summaryInputs } = candidate;
    assertEquals(summaryInputs.versions, {
      deno: "2.9.3",
      codex: "0.145.0",
    });
    assertEquals(summaryInputs.platform, { os: "darwin", arch: "aarch64" });
    assertEquals(summaryInputs.lifecycle.terminalStatus, "completed");
    assert(summaryInputs.lifecycle.completedAgentMessages > 0);
    assert(summaryInputs.lifecycle.completedItems > 0);
    assert(summaryInputs.lifecycle.stdoutLines > 0);
    assert(
      Object.values(summaryInputs.observationsMs).every((value) =>
        Number.isFinite(value) && value >= 0
      ),
      "all required measurements must be present and non-negative",
    );
    assert(
      candidate.transcript.every((record) => record.schema.valid === true),
      "every retained envelope must have a pinned schema proof",
    );
    assert(
      candidate.coverage.entries.some((entry) =>
        entry.direction === "client-request" &&
        entry.method === "turn/start" &&
        entry.observedCount === 1 &&
        entry.disposition === "exercised"
      ),
      "run-derived coverage must include the authenticated turn",
    );
    assert(summaryInputs.shutdown.directExit !== undefined);
    assertEquals(summaryInputs.shutdown.drains, {
      stdoutCompleted: true,
      stderrCompleted: true,
    });
    assertEquals(summaryInputs.shutdown.remainingPids, []);
    assertEquals(
      summaryInputs.shutdown.noObservedDescendantsRemain,
      true,
    );
    assertEquals(
      summaryInputs.shutdown.escapedDescendantContainmentProven,
      false,
    );
    assert(
      summaryInputs.shutdown.diagnostics.some((diagnostic) =>
        diagnostic.code === "CONTAINMENT_UNPROVEN"
      ),
      "snapshot-only containment limitation must remain explicit",
    );
    const encoded = JSON.stringify(candidate);
    assert(!/(?:\/Users\/|\/home\/)/.test(encoded));
    assert(!/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{16,}/i.test(encoded));
  },
});
