import { describe, it, expect } from 'vitest';
import type { Nimble } from '@nimble-way/nimble-js';
import type {
  RunCreateParams,
  RunCreateResponse,
  RunGetResponse,
  RunResultResponse,
} from '@nimble-way/nimble-js/resources/agents/runs';
import type {
  NimbleAgentRawFailedResult,
  NimbleAgentRawResult,
  NimbleAgentRawRun,
  NimbleAgentRunCreateBody,
  NimbleAgentRunsClient,
} from '../src/agent-schemas';
import { rawRun } from './agent-fixtures';

/**
 * Compile-time contract between this package's structural types and the
 * generated types of `@nimble-way/nimble-js`. If the SDK's generated agent
 * types drift, these assignments stop compiling — turning a silent runtime
 * break into a typecheck failure.
 */

// Compile-time-only: this function is never called; its body exists so tsc
// checks the assignments. (`declare const` would be erased and crash at
// runtime, so the values arrive as parameters instead.)
function compileTimeContract(
  sdkCreateResponse: RunCreateResponse,
  sdkGetResponse: RunGetResponse,
  sdkResultResponse: RunResultResponse,
  packageBody: Required<NimbleAgentRunCreateBody>,
  realClient: Nimble,
) {
  // Responses the package READS: SDK generated → structural must be assignable.
  const readCreate: NimbleAgentRawRun = sdkCreateResponse;
  const readGet: NimbleAgentRawRun = sdkGetResponse;
  const readResult: NimbleAgentRawResult | NimbleAgentRawFailedResult = sdkResultResponse;

  // The body the package SENDS: structural → SDK generated must be assignable.
  const sendBody: RunCreateParams = packageBody;

  // The real client instance must satisfy the structural surface the tools use
  // (this is the exact assumption behind resolveAgentContext's cast).
  const clientSurface: NimbleAgentRunsClient = realClient;

  return { readCreate, readGet, readResult, sendBody, clientSurface };
}

// Fixtures used across the test suite conform to the SDK generated types, so
// mocked behavior can't drift from real payload shapes either. (The result
// fixture is asserted via an SDK-typed literal: our merged claim type keeps
// `callout`/`path` optional across text/json variants, so only the SDK→ours
// read direction holds for full result unions — by design.)
const _fixtureRun: RunGetResponse = rawRun();
const _fixtureResult: RunResultResponse = {
  run: rawRun({ status: 'completed', is_active: false }),
  output: {
    type: 'text',
    content: 'answer [1]',
    trust: {
      confidence: 'high',
      reasoning: 'primary source',
      sources: [{ url: 'https://example.org', type: 'primary' }],
      claims: [
        {
          callout: 1,
          confidence: 'high',
          reasoning: 'verbatim',
          citations: [{ url: 'https://example.org', excerpts: ['line'] }],
        },
      ],
    },
  },
};

describe('SDK type compatibility', () => {
  it('structural types line up with @nimble-way/nimble-js generated types (compile-time)', () => {
    // The real assertions are compile-time; reference the values so
    // noUnusedLocals stays green and the fixtures actually evaluate.
    expect(typeof compileTimeContract).toBe('function');
    expect(_fixtureRun.id).toBe(rawRun().id);
    expect(_fixtureResult.run.status).toBe('completed');
  });
});
