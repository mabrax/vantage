import {
  createDraft07Ajv,
  numericFormatValidators,
  ProtocolValidator,
  SchemaValidationError,
  validateJsonAgainstSchema,
} from "../src/protocol_validation.ts";
import { discoverRepositoryRoot, loadConfiguration } from "../src/config.ts";

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

function assertThrowsCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    assert(
      error instanceof Error && error.message.startsWith(`${code}:`),
      `expected ${code}, received ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  throw new Error(`expected ${code}`);
}

async function loadValidator(): Promise<ProtocolValidator> {
  const root = await discoverRepositoryRoot();
  return await ProtocolValidator.load(
    `${root}/spikes/codex-app-server/generated/0.145.0/json-schema`,
  );
}

Deno.test("compiles every generated draft-07 top-level schema exactly once", async () => {
  const validator = await loadValidator();
  const configuration = await loadConfiguration();
  assertEquals(
    validator.compiledSchemas.size,
    configuration.generation.fileCounts.jsonSchema,
  );
  for (
    const direction of [
      "client-request",
      "client-notification",
      "server-notification",
      "server-request",
    ] as const
  ) {
    assertEquals(
      validator.methods.get(direction)?.size,
      configuration.coverage.entries.filter((entry) =>
        entry.direction === direction
      ).length,
    );
  }
  assertEquals(
    [...validator.responseValidators.keys()].filter((key) =>
      key.startsWith("client-request\u0000")
    ).length,
    validator.methods.get("client-request")?.size,
  );
  assertEquals(
    [...validator.responseValidators.keys()].filter((key) =>
      key.startsWith("server-request\u0000")
    ).length,
    validator.methods.get("server-request")?.size,
  );
});

Deno.test("validates complete known envelopes and rejects unknown or malformed methods", async () => {
  const validator = await loadValidator();
  validator.validateEnvelope("client-notification", { method: "initialized" });
  validator.validateEnvelope("client-request", {
    method: "initialize",
    id: 1,
    params: {
      clientInfo: {
        name: "vantage-compatibility-spike",
        version: "1",
      },
    },
  });
  validator.validateParams("client-request", "account/logout", undefined);
  validator.validateResult("client-request", "account/logout", {});
  validator.validateResult("client-request", "config/mcpServer/reload", {});
  validator.validateResponseEnvelope("client-request", "initialize", {
    id: 1,
    result: {
      codexHome: "/tmp/codex-home",
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: "codex",
    },
  });
  validator.validateGenericMessage({
    method: "skills/changed",
    params: {},
  });
  validator.validateEnvelope("server-notification", {
    method: "skills/changed",
    params: {},
  });
  validator.validateResponseEnvelope("client-request", "initialize", {
    id: 1,
    error: {
      code: -32601,
      message: "Method not found",
    },
  });
  validator.validateErrorResponseEnvelope({
    id: "server-request-1",
    error: {
      code: -32601,
      message: "Method not found",
    },
  });
  assertThrowsCode(
    () =>
      validator.validateEnvelope("client-request", {
        method: "initialize",
        id: 1,
        params: {},
      }),
    "PROTOCOL_SCHEMA_INVALID",
  );
  assertThrowsCode(
    () =>
      validator.validateEnvelope("client-request", {
        method: "experimental/not-generated",
        id: 1,
        params: {},
      }),
    "UNKNOWN_PROTOCOL_METHOD",
  );
  assertThrowsCode(
    () => validator.validateResult("client-request", "initialize", {}),
    "PROTOCOL_RESULT_SCHEMA_INVALID",
  );
  assertThrowsCode(
    () =>
      validator.validateResponseEnvelope("client-request", "initialize", {
        result: {},
      }),
    "PROTOCOL_RESPONSE_ENVELOPE_INVALID",
  );
  assertThrowsCode(
    () =>
      validator.validateErrorResponseEnvelope({
        id: 1,
        error: { code: "not-an-int64", message: "bad" },
      }),
    "PROTOCOL_RESPONSE_ENVELOPE_INVALID",
  );
  assertThrowsCode(
    () =>
      validator.validateEnvelope("server-notification", {
        method: "future/notification",
        params: {},
      }),
    "UNKNOWN_PROTOCOL_METHOD",
  );
});

Deno.test("numeric formats enforce exact safe JSON ranges", () => {
  const cases: Record<string, { valid: number[]; invalid: number[] }> = {
    uint: {
      valid: [0, Number.MAX_SAFE_INTEGER],
      invalid: [-1, 1.5, Number.MAX_SAFE_INTEGER + 1],
    },
    uint16: { valid: [0, 65_535], invalid: [-1, 65_536, 1.5] },
    uint32: { valid: [0, 4_294_967_295], invalid: [-1, 4_294_967_296, 1.5] },
    int64: {
      valid: [Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER],
      invalid: [Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1, 1.5],
    },
    int32: {
      valid: [-2_147_483_648, 2_147_483_647],
      invalid: [-2_147_483_649, 2_147_483_648, 1.5],
    },
    uint64: {
      valid: [0, Number.MAX_SAFE_INTEGER],
      invalid: [-1, Number.MAX_SAFE_INTEGER + 1, 1.5],
    },
    double: {
      valid: [-Number.MAX_VALUE, 0, Number.MAX_VALUE],
      invalid: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NaN],
    },
  };
  for (const [name, boundaries] of Object.entries(cases)) {
    const validate = numericFormatValidators[name];
    assert(validate, `missing numeric format ${name}`);
    for (const value of boundaries.valid) {
      assert(validate(value), `${name} should accept ${value}`);
    }
    for (const value of boundaries.invalid) {
      assert(!validate(value), `${name} should reject ${value}`);
    }
  }
});

Deno.test("all unregistered formats remain fatal at compile time", () => {
  assertThrowsCode(
    () =>
      validateJsonAgainstSchema(
        {
          "$schema": "http://json-schema.org/draft-07/schema#",
          type: "string",
          format: "codex-unknown",
        },
        "value",
      ),
    "SCHEMA_COMPILE_FAILED",
  );
  const ajv = createDraft07Ajv();
  assertThrowsCode(
    () => {
      try {
        ajv.compile({ type: "number", format: "another-unknown" });
      } catch (error) {
        throw new SchemaValidationError(
          "SCHEMA_COMPILE_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    "SCHEMA_COMPILE_FAILED",
  );
});
