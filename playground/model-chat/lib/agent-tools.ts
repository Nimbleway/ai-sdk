import {
  nimbleAgentRunResult,
  nimbleAgentRunStatus,
  nimbleAgentStartRun,
} from '@nimble-way/ai-sdk';

export const POLL_INTERVAL_MS = 10_000;
export const RESULT_TIMEOUT_MS = 300_000;

const MAX_OUTPUT_SCHEMA_BYTES = 16 * 1_024;
const MAX_OUTPUT_SCHEMA_DEPTH = 8;
const MAX_OUTPUT_SCHEMA_NODES = 256;
const MAX_OUTPUT_SCHEMA_PROPERTIES = 128;

const JSON_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'additionalProperties',
  'const',
  'description',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'multipleOf',
  'properties',
  'required',
  'title',
  'type',
  'uniqueItems',
]);

type ToolFactories = {
  start: typeof nimbleAgentStartRun;
  status: typeof nimbleAgentRunStatus;
  result: typeof nimbleAgentRunResult;
};

type ExecutableTool = {
  execute?: (input: Record<string, unknown>, options: unknown) => Promise<Record<string, unknown>>;
};

const defaultFactories: ToolFactories = {
  start: nimbleAgentStartRun,
  status: nimbleAgentRunStatus,
  result: nimbleAgentRunResult,
};

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function schemaType(
  value: unknown,
  path: string,
): { type?: string; error?: string } {
  if (typeof value === 'string') {
    return JSON_SCHEMA_TYPES.has(value)
      ? { type: value }
      : { error: `${path}.type must be a supported JSON Schema type` };
  }
  if (!Array.isArray(value) || value.length !== 2) {
    return {
      error:
        `${path}.type must be one supported type or a two-type nullable union`,
    };
  }
  const types = value.filter((entry): entry is string => typeof entry === 'string');
  if (
    types.length !== 2 ||
    new Set(types).size !== 2 ||
    !types.includes('null') ||
    types.some((entry) => !JSON_SCHEMA_TYPES.has(entry))
  ) {
    return {
      error:
        `${path}.type nullable unions must contain "null" and one supported type`,
    };
  }
  return { type: types.find((entry) => entry !== 'null') };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

type SchemaValidationState = {
  nodes: number;
  nodeLimitReported: boolean;
  issues: string[];
};

function schemaIssue(state: SchemaValidationState, issue: string) {
  state.issues.push(issue);
}

function validateSchemaNode(
  value: unknown,
  path: string,
  depth: number,
  state: SchemaValidationState,
  root = false,
): void {
  if (!plainRecord(value)) {
    schemaIssue(state, `${path} must be a JSON Schema object`);
    return;
  }
  if (depth > MAX_OUTPUT_SCHEMA_DEPTH) {
    schemaIssue(state, `${path} exceeds the maximum schema depth`);
    return;
  }
  if (state.nodes >= MAX_OUTPUT_SCHEMA_NODES) {
    if (!state.nodeLimitReported) {
      schemaIssue(state, `${path} exceeds the maximum schema node count`);
      state.nodeLimitReported = true;
    }
    return;
  }
  state.nodes += 1;

  if ('$ref' in value) {
    schemaIssue(state, `${path} cannot use $ref`);
  }
  const unsupportedKeywords = Object.keys(value).filter(
    (keyword) => keyword !== '$ref' && !SUPPORTED_SCHEMA_KEYWORDS.has(keyword),
  );
  if (unsupportedKeywords.length > 0) {
    schemaIssue(
      state,
      `${path} uses unsupported keywords: ${unsupportedKeywords.join(', ')}`,
    );
  }

  const resolvedType = schemaType(value.type, path);
  if (resolvedType.error) {
    schemaIssue(state, resolvedType.error);
  }
  const type = resolvedType.type;
  if (root && type !== undefined && type !== 'object' && type !== 'array') {
    schemaIssue(state, `${path}.type must be "object" or "array" at the root`);
  }

  const hasProperties = 'properties' in value;
  const hasItems = 'items' in value;
  const hasRequired = 'required' in value;
  const hasAdditionalProperties = 'additionalProperties' in value;
  let properties: Record<string, unknown> | undefined;

  // Traverse every recognizable schema-bearing keyword independently of its
  // parent's type. This lets the one permitted local correction disclose
  // nested issues even when the parent type itself is missing or mismatched.
  if (hasProperties) {
    if (!plainRecord(value.properties)) {
      schemaIssue(
        state,
        `${path}.properties must be an object of typed property schemas`,
      );
    } else {
      properties = value.properties;
      const propertyEntries = Object.entries(properties);
      if (propertyEntries.length === 0) {
        schemaIssue(state, `${path}.properties must define at least one property`);
      }
      if (propertyEntries.length > MAX_OUTPUT_SCHEMA_PROPERTIES) {
        schemaIssue(state, `${path}.properties exceeds the maximum property count`);
      }
      for (const [name, propertySchema] of propertyEntries) {
        validateSchemaNode(
          propertySchema,
          `${path}.properties.${name}`,
          depth + 1,
          state,
        );
      }
    }
  }
  if (hasItems) {
    validateSchemaNode(value.items, `${path}.items`, depth + 1, state);
  }
  if (
    hasAdditionalProperties &&
    typeof value.additionalProperties !== 'boolean'
  ) {
    validateSchemaNode(
      value.additionalProperties,
      `${path}.additionalProperties`,
      depth + 1,
      state,
    );
  }
  if (hasRequired) {
    if (
      !Array.isArray(value.required) ||
      value.required.some(
        (entry) => typeof entry !== 'string' || entry.length === 0,
      )
    ) {
      schemaIssue(
        state,
        `${path}.required must contain non-empty property names`,
      );
    } else {
      const required = value.required as string[];
      if (
        new Set(required).size !== required.length ||
        (properties !== undefined &&
          required.some((name) => !Object.hasOwn(properties, name)))
      ) {
        schemaIssue(
          state,
          `${path}.required must contain unique names defined in properties`,
        );
      }
    }
  }

  if (type === 'object') {
    if (!hasProperties) {
      schemaIssue(
        state,
        `${path}.properties must be an object of typed property schemas`,
      );
    }

    if (hasItems) {
      schemaIssue(state, `${path}.items is only valid for an array schema`);
    }
  } else if (type === 'array') {
    if (!hasItems) {
      schemaIssue(state, `${path}.items must define the typed array item schema`);
    }
    if (hasProperties || hasRequired || hasAdditionalProperties) {
      schemaIssue(
        state,
        `${path} cannot use object-only keywords for an array schema`,
      );
    }
  } else if (hasProperties || hasItems || hasRequired || hasAdditionalProperties) {
    schemaIssue(
      state,
      `${path} cannot use object or array keywords for type "${type}"`,
    );
  }

  for (const keyword of [
    'exclusiveMaximum',
    'exclusiveMinimum',
    'maximum',
    'minimum',
  ]) {
    if (keyword in value && !finiteNumber(value[keyword])) {
      schemaIssue(state, `${path}.${keyword} must be a finite number`);
    }
  }
  if (
    'multipleOf' in value &&
    (!finiteNumber(value.multipleOf) || value.multipleOf <= 0)
  ) {
    schemaIssue(state, `${path}.multipleOf must be a positive finite number`);
  }
  for (const keyword of ['maxItems', 'maxLength', 'minItems', 'minLength']) {
    const candidate = value[keyword];
    if (
      keyword in value &&
      (!finiteNumber(candidate) || !Number.isInteger(candidate) || candidate < 0)
    ) {
      schemaIssue(state, `${path}.${keyword} must be a non-negative integer`);
    }
  }
  if ('uniqueItems' in value && typeof value.uniqueItems !== 'boolean') {
    schemaIssue(state, `${path}.uniqueItems must be a boolean`);
  }
  for (const keyword of ['description', 'format', 'title']) {
    if (keyword in value && typeof value[keyword] !== 'string') {
      schemaIssue(state, `${path}.${keyword} must be a string`);
    }
  }
  if ('enum' in value) {
    if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 100) {
      schemaIssue(state, `${path}.enum must contain between 1 and 100 values`);
    } else {
      if (
        value.enum.some(
          (entry) =>
            entry !== null &&
            typeof entry !== 'string' &&
            typeof entry !== 'boolean' &&
            !finiteNumber(entry),
        )
      ) {
        schemaIssue(state, `${path}.enum supports only JSON scalar values`);
      }
      const enumKeys = value.enum.map(
        (entry) => `${typeof entry}:${JSON.stringify(entry)}`,
      );
      if (new Set(enumKeys).size !== enumKeys.length) {
        schemaIssue(state, `${path}.enum values must be unique`);
      }
    }
  }
  if (
    'const' in value &&
    value.const !== null &&
    typeof value.const !== 'string' &&
    typeof value.const !== 'boolean' &&
    !finiteNumber(value.const)
  ) {
    schemaIssue(state, `${path}.const supports only a JSON scalar value`);
  }
}

function validateModelOutputSchema(outputSchema: unknown): string | undefined {
  if (outputSchema === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(outputSchema);
  } catch {
    return 'outputSchema must be JSON-serializable';
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_OUTPUT_SCHEMA_BYTES) {
    return `outputSchema exceeds ${MAX_OUTPUT_SCHEMA_BYTES} bytes`;
  }
  const state: SchemaValidationState = {
    nodes: 0,
    nodeLimitReported: false,
    issues: [],
  };
  validateSchemaNode(outputSchema, 'outputSchema', 0, state, true);
  return state.issues.length > 0 ? state.issues.join('; ') : undefined;
}

/**
 * Request-scoped tools for the model-driven demo. No agentId is configured,
 * so startResearch uses POST /v2/agents/runs and preserves the generated
 * agentId returned with the run. Create is pinned to low; the package itself
 * disables retries for the non-idempotent create request.
 */
export function buildAgentTools(apiKey: string, factories: ToolFactories = defaultFactories) {
  const tools = {
    startResearch: factories.start({ apiKey, effort: 'low' }),
    checkResearch: factories.status({ apiKey }),
    getResearchResult: factories.result({
      apiKey,
      wait: {
        pollIntervalMs: POLL_INTERVAL_MS,
        timeoutMs: RESULT_TIMEOUT_MS,
      },
    }),
  };

  const start = tools.startResearch as ExecutableTool;
  const status = tools.checkResearch as ExecutableTool;
  const result = tools.getResearchResult as ExecutableTool;
  if (!start.execute || !status.execute || !result.execute) {
    throw new Error('Agent tools must provide server-side execute handlers.');
  }

  const executeStart = start.execute.bind(start);
  const executeStatus = status.execute.bind(status);
  const executeResult = result.execute.bind(result);
  let createPromise: Promise<Record<string, unknown>> | undefined;

  const guardedStart = {
    ...start,
    execute(input: Record<string, unknown>, options: unknown) {
      if (createPromise) return createPromise;
      const validationError = validateModelOutputSchema(input.outputSchema);
      if (validationError) {
        return Promise.reject(
          new Error(
            `outputSchema was rejected before any Agent API request: ${validationError}. ` +
              'Use this playground subset (type, properties/items, required, ' +
              'additionalProperties, scalar enum/const, descriptions, formats, and ' +
              'basic bounds), or omit outputSchema.',
          ),
        );
      }
      if (input.inputData !== undefined && input.outputSchema === undefined) {
        return Promise.reject(
          new Error(
            'inputData was rejected before any Agent API request: provide a matching ' +
              'typed outputSchema, or omit inputData.',
          ),
        );
      }
      try {
        createPromise = Promise.resolve(executeStart(input, options));
      } catch (error) {
        createPromise = Promise.reject(error);
      }
      return createPromise;
    },
  };

  async function assertGuardedIds(input: Record<string, unknown>) {
    if (!createPromise) {
      throw new Error('Start the research run before checking its lifecycle.');
    }
    const created = await createPromise;
    if (input.runId !== created.runId || input.agentId !== created.agentId) {
      throw new Error('Lifecycle IDs must match the run created in this request.');
    }
  }

  return {
    startResearch: guardedStart,
    checkResearch: {
      ...status,
      async execute(input: Record<string, unknown>, options: unknown) {
        await assertGuardedIds(input);
        return executeStatus(input, options);
      },
    },
    getResearchResult: {
      ...result,
      async execute(input: Record<string, unknown>, options: unknown) {
        await assertGuardedIds(input);
        return executeResult(input, options);
      },
    },
  } as unknown as typeof tools;
}
