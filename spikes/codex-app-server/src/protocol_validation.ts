import AjvModule, {
  type AnySchema,
  type ErrorObject,
  type Format,
  type Options,
  type ValidateFunction,
} from "ajv";

export type JsonSchema = Record<string, unknown>;

const NUMERIC_FORMATS: Record<string, (value: number) => boolean> = {
  uint: (value) => Number.isSafeInteger(value) && value >= 0,
  uint16: (value) => Number.isInteger(value) && value >= 0 && value <= 65_535,
  uint32: (value) =>
    Number.isInteger(value) && value >= 0 && value <= 4_294_967_295,
  int64: (value) => Number.isSafeInteger(value),
  // Codex 0.145.0 also emits these in its stable tree. Keeping them explicit
  // preserves Ajv's fatal handling for every format not owned by this boundary.
  int32: (value) =>
    Number.isInteger(value) && value >= -2_147_483_648 &&
    value <= 2_147_483_647,
  uint64: (value) => Number.isSafeInteger(value) && value >= 0,
  double: (value) => Number.isFinite(value),
};

export class SchemaValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly errors: ErrorObject[] = [],
  ) {
    super(`${code}: ${message}`);
    this.name = "SchemaValidationError";
  }
}

type AjvInstance = {
  addFormat(name: string, format: Format): AjvInstance;
  compile(schema: AnySchema): ValidateFunction;
};

const Ajv = AjvModule as unknown as new (options?: Options) => AjvInstance;

export function createDraft07Ajv(): AjvInstance {
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    strictSchema: true,
    strictTypes: false,
    validateFormats: true,
    messages: true,
    logger: false,
  });
  for (const [name, validate] of Object.entries(NUMERIC_FORMATS)) {
    ajv.addFormat(name, { type: "number", validate });
  }
  return ajv;
}

export function validateJsonAgainstSchema(
  schema: unknown,
  value: unknown,
  code = "SCHEMA_VALIDATION_FAILED",
): void {
  let validate: ValidateFunction;
  try {
    validate = createDraft07Ajv().compile(schema as AnySchema);
  } catch (error) {
    throw new SchemaValidationError(
      "SCHEMA_COMPILE_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!validate(value)) {
    throw new SchemaValidationError(
      code,
      "value does not satisfy schema",
      validate.errors ?? [],
    );
  }
}

async function walkSchemaPaths(root: string, relative = ""): Promise<string[]> {
  const paths: string[] = [];
  const entries = [];
  for await (
    const entry of Deno.readDir(relative ? `${root}/${relative}` : root)
  ) {
    entries.push(entry);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory) paths.push(...await walkSchemaPaths(root, path));
    else if (entry.isFile && entry.name.endsWith(".json")) paths.push(path);
  }
  return paths;
}

export type ProtocolDirection =
  | "client-request"
  | "client-notification"
  | "server-notification"
  | "server-request";

const DIRECTION_SCHEMA: Record<ProtocolDirection, string> = {
  "client-request": "ClientRequest.json",
  "client-notification": "ClientNotification.json",
  "server-notification": "ServerNotification.json",
  "server-request": "ServerRequest.json",
};

export class ProtocolValidator {
  readonly compiledSchemas = new Map<string, ValidateFunction>();
  readonly directionValidators = new Map<ProtocolDirection, ValidateFunction>();
  readonly methods = new Map<ProtocolDirection, ReadonlySet<string>>();
  readonly responseValidators = new Map<string, ValidateFunction>();

  private constructor() {}

  static async load(schemaRoot: string): Promise<ProtocolValidator> {
    const result = new ProtocolValidator();
    for (const relativePath of await walkSchemaPaths(schemaRoot)) {
      const schema = JSON.parse(
        await Deno.readTextFile(`${schemaRoot}/${relativePath}`),
      );
      try {
        const validate = createDraft07Ajv().compile(schema);
        result.compiledSchemas.set(relativePath, validate);
      } catch (error) {
        throw new SchemaValidationError(
          "SCHEMA_COMPILE_FAILED",
          `${relativePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    for (
      const [direction, relativePath] of Object.entries(DIRECTION_SCHEMA) as [
        ProtocolDirection,
        string,
      ][]
    ) {
      const validate = result.compiledSchemas.get(relativePath);
      if (!validate) {
        throw new SchemaValidationError(
          "TOP_LEVEL_SCHEMA_MISSING",
          `missing generated top-level schema ${relativePath}`,
        );
      }
      result.directionValidators.set(direction, validate);
      const schema = JSON.parse(
        await Deno.readTextFile(`${schemaRoot}/${relativePath}`),
      );
      result.methods.set(direction, extractMethodsFromUnionSchema(schema));
    }
    const responsePaths = new Map<string, string>();
    for (const path of result.compiledSchemas.keys()) {
      if (!path.endsWith("Response.json") || path === "JSONRPCResponse.json") {
        continue;
      }
      const basename = path.split("/").at(-1)!;
      if (responsePaths.has(basename)) {
        throw new SchemaValidationError(
          "DUPLICATE_RESPONSE_SCHEMA_NAME",
          `generated response basename is ambiguous: ${basename}`,
        );
      }
      responsePaths.set(basename, path);
    }
    await result.#indexResponses(
      schemaRoot,
      "client-request",
      "ClientRequest.json",
      responsePaths,
    );
    await result.#indexResponses(
      schemaRoot,
      "server-request",
      "ServerRequest.json",
      responsePaths,
    );
    return result;
  }

  async #indexResponses(
    schemaRoot: string,
    direction: "client-request" | "server-request",
    unionPath: string,
    responsePaths: ReadonlyMap<string, string>,
  ): Promise<void> {
    const schema = JSON.parse(
      await Deno.readTextFile(`${schemaRoot}/${unionPath}`),
    ) as Record<string, unknown>;
    const variants = schema.oneOf as Record<string, unknown>[];
    for (const variant of variants) {
      const properties = variant.properties as Record<string, unknown>;
      const method =
        ((properties.method as Record<string, unknown>).enum as string[])[0];
      const paramsReference =
        (properties.params as Record<string, unknown> | undefined)?.$ref;
      const parameterName = typeof paramsReference === "string"
        ? paramsReference.split("/").at(-1)
        : undefined;
      const responseName = parameterName?.endsWith("Params")
        ? `${parameterName.slice(0, -"Params".length)}Response.json`
        : undefined;
      const generatedName = responseName && responsePaths.has(responseName)
        ? responseName
        : CLIENT_RESPONSE_NAME_EXCEPTIONS[method];
      if (!generatedName || !responsePaths.has(generatedName)) {
        throw new SchemaValidationError(
          "METHOD_RESPONSE_SCHEMA_MISSING",
          `no generated response schema is correlated with ${direction} ${method}`,
        );
      }
      const path = responsePaths.get(generatedName)!;
      const validate = this.compiledSchemas.get(path);
      if (!validate) {
        throw new SchemaValidationError(
          "METHOD_RESPONSE_SCHEMA_MISSING",
          `generated response schema was not compiled: ${path}`,
        );
      }
      this.responseValidators.set(`${direction}\u0000${method}`, validate);
    }
  }

  validateEnvelope(direction: ProtocolDirection, envelope: unknown): void {
    const validate = this.directionValidators.get(direction);
    if (!validate) {
      throw new SchemaValidationError(
        "UNKNOWN_PROTOCOL_DIRECTION",
        `unknown protocol direction ${direction}`,
      );
    }
    const method = envelope !== null && typeof envelope === "object"
      ? (envelope as Record<string, unknown>).method
      : undefined;
    if (
      typeof method !== "string" || !this.methods.get(direction)?.has(method)
    ) {
      throw new SchemaValidationError(
        "UNKNOWN_PROTOCOL_METHOD",
        `method ${String(method)} is absent from pinned ${direction} schema`,
      );
    }
    if (!validate(envelope)) {
      throw new SchemaValidationError(
        "PROTOCOL_SCHEMA_INVALID",
        `${direction} envelope for ${method} does not satisfy its pinned schema`,
        validate.errors ?? [],
      );
    }
  }

  validateParams(
    direction: "client-request" | "server-request",
    method: string,
    params: unknown,
  ): void {
    const envelope: Record<string, unknown> = { method, id: 0 };
    if (params !== undefined) envelope.params = params;
    this.validateEnvelope(direction, envelope);
  }

  validateResult(
    direction: "client-request" | "server-request",
    method: string,
    result: unknown,
  ): void {
    const validate = this.responseValidators.get(`${direction}\u0000${method}`);
    if (!validate) {
      throw new SchemaValidationError(
        "UNKNOWN_PROTOCOL_METHOD",
        `method ${method} has no pinned response schema for ${direction}`,
      );
    }
    if (!validate(result)) {
      throw new SchemaValidationError(
        "PROTOCOL_RESULT_SCHEMA_INVALID",
        `${direction} result for ${method} does not satisfy its pinned schema`,
        validate.errors ?? [],
      );
    }
  }

  validateResponseEnvelope(
    direction: "client-request" | "server-request",
    method: string,
    envelope: unknown,
  ): void {
    if (
      envelope !== null && typeof envelope === "object" &&
      "error" in envelope
    ) {
      const errorEnvelope = this.compiledSchemas.get("JSONRPCError.json");
      if (!errorEnvelope || !errorEnvelope(envelope)) {
        throw new SchemaValidationError(
          "PROTOCOL_RESPONSE_ENVELOPE_INVALID",
          `error response envelope for ${method} is not valid JSON-RPC`,
          errorEnvelope?.errors ?? [],
        );
      }
      return;
    }
    const generic = this.compiledSchemas.get("JSONRPCResponse.json");
    if (!generic || !generic(envelope)) {
      throw new SchemaValidationError(
        "PROTOCOL_RESPONSE_ENVELOPE_INVALID",
        `response envelope for ${method} is not valid JSON-RPC`,
        generic?.errors ?? [],
      );
    }
    const result = envelope !== null && typeof envelope === "object"
      ? (envelope as Record<string, unknown>).result
      : undefined;
    this.validateResult(direction, method, result);
  }

  validateGenericMessage(envelope: unknown): void {
    const validate = this.compiledSchemas.get("JSONRPCMessage.json");
    if (!validate || !validate(envelope)) {
      throw new SchemaValidationError(
        "PROTOCOL_ENVELOPE_INVALID",
        "value is not a generated JSON-RPC message",
        validate?.errors ?? [],
      );
    }
  }

  validateErrorResponseEnvelope(envelope: unknown): void {
    const validate = this.compiledSchemas.get("JSONRPCError.json");
    if (!validate || !validate(envelope)) {
      throw new SchemaValidationError(
        "PROTOCOL_RESPONSE_ENVELOPE_INVALID",
        "value is not a generated JSON-RPC error response",
        validate?.errors ?? [],
      );
    }
  }
}

// The generated request unions identify parameter types but do not emit a
// request-to-response map. Most names correlate mechanically. These are the
// complete stable 0.145.0 naming exceptions; loading still derives method
// membership from the unions and fails closed if any generated association is
// missing.
const CLIENT_RESPONSE_NAME_EXCEPTIONS: Readonly<Record<string, string>> = {
  "config/mcpServer/reload": "McpServerRefreshResponse.json",
  "windowsSandbox/readiness": "WindowsSandboxReadinessResponse.json",
  "account/logout": "LogoutAccountResponse.json",
  "account/rateLimits/read": "GetAccountRateLimitsResponse.json",
  "account/usage/read": "GetAccountTokenUsageResponse.json",
  "account/workspaceMessages/read": "GetWorkspaceMessagesResponse.json",
  "externalAgentConfig/import/readHistories":
    "ExternalAgentConfigImportHistoriesReadResponse.json",
  "config/value/write": "ConfigWriteResponse.json",
  "config/batchWrite": "ConfigWriteResponse.json",
  "configRequirements/read": "ConfigRequirementsReadResponse.json",
};

export function extractMethodsFromUnionSchema(
  schema: unknown,
): ReadonlySet<string> {
  if (schema === null || typeof schema !== "object") {
    throw new SchemaValidationError(
      "METHOD_EXTRACTION_FAILED",
      "union schema is not an object",
    );
  }
  const branches = (schema as Record<string, unknown>).oneOf;
  const variants = Array.isArray(branches) ? branches : [schema];
  const methods = new Set<string>();
  for (const variant of variants) {
    const methodSchema = variant && typeof variant === "object"
      ? ((variant as Record<string, unknown>).properties as
        | Record<string, unknown>
        | undefined)
        ?.method
      : undefined;
    const values = methodSchema && typeof methodSchema === "object"
      ? (methodSchema as Record<string, unknown>).enum
      : undefined;
    if (
      !Array.isArray(values) || values.length !== 1 ||
      typeof values[0] !== "string"
    ) {
      throw new SchemaValidationError(
        "METHOD_EXTRACTION_FAILED",
        "every union variant must expose exactly one literal method",
      );
    }
    if (methods.has(values[0])) {
      throw new SchemaValidationError(
        "DUPLICATE_GENERATED_METHOD",
        `generated union repeats method ${values[0]}`,
      );
    }
    methods.add(values[0]);
  }
  return methods;
}

export const numericFormatValidators = Object.freeze({ ...NUMERIC_FORMATS });
