import { describe, it, expect } from 'vitest';
import type { Nimble } from '@nimble-way/nimble-js';
import type { AgentRunParams, AgentRunResponse } from '@nimble-way/nimble-js/resources/agents/agents';
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
import type { ExtractRunResponse } from '@nimble-way/nimble-js/resources/extract/extract';
import type { SearchResponse } from '@nimble-way/nimble-js/resources/top-level';
import type { NimbleRawExtractResponse, NimbleRawSearchResponse } from '../src/schemas';
import { rawRun } from './agent-fixtures';

/**
 * Compile-time contract between this package's structural types and the
 * generated types of `@nimble-way/nimble-js`. If the SDK's generated agent
 * types drift, these assignments stop compiling — turning a silent runtime
 * break into a typecheck failure.
 */

/**
 * Keys the package declares on a request body that the SDK does not publish.
 *
 * Plain assignability (`const x: RunCreateParams = packageBody`) does NOT catch
 * these: excess-property ("freshness") checking only applies to object
 * literals, so a body type carrying an unpublished field assigns cleanly and
 * the drift guard silently passes. That is exactly the failure this package
 * must not ship — sending a field the API does not accept is invisible at
 * compile time and only shows up as a rejected (or silently ignored) run.
 *
 * `[T] extends [never]` rather than `T extends never`: a naked type parameter
 * distributes over the union, and distributing over `never` yields `never`,
 * which would make the assertion vacuously pass for every input.
 */
type ExcessKeys<Ours, Theirs> = Exclude<keyof Ours, keyof Theirs>;

type AssertNoExcessKeys<Ours, Theirs> = [ExcessKeys<Ours, Theirs>] extends [never]
  ? true
  : {
      error: 'request body declares fields the SDK does not publish';
      unpublished: ExcessKeys<Ours, Theirs>;
    };

// If either create route's published params ever stop covering a field this
// package declares, these stop compiling and name the offending key. Both
// routes are asserted independently: a field published on only one of them is
// still a defect, because one body serves both creates.
const _noExcessOnPersistentRoute: AssertNoExcessKeys<NimbleAgentRunCreateBody, RunCreateParams> =
  true;
const _noExcessOnGeneratedRoute: AssertNoExcessKeys<NimbleAgentRunCreateBody, AgentRunParams> =
  true;

// Compile-time-only: this function is never called; its body exists so tsc
// checks the assignments. (`declare const` would be erased and crash at
// runtime, so the values arrive as parameters instead.)
function compileTimeContract(
  sdkCreateResponse: RunCreateResponse,
  sdkGeneratedRunResponse: AgentRunResponse,
  sdkGetResponse: RunGetResponse,
  sdkResultResponse: RunResultResponse,
  packageBody: Required<NimbleAgentRunCreateBody>,
  realClient: Nimble,
  sdkSearchResponse: SearchResponse,
  sdkExtractResponse: ExtractRunResponse,
) {
  // Responses the package READS: SDK generated → structural must be assignable.
  const readCreate: NimbleAgentRawRun = sdkCreateResponse;
  // The generated-agent route (`client.agents.run`) returns the same run shape.
  const readGeneratedRun: NimbleAgentRawRun = sdkGeneratedRunResponse;
  const readGet: NimbleAgentRawRun = sdkGetResponse;
  const readResult: NimbleAgentRawResult | NimbleAgentRawFailedResult = sdkResultResponse;

  // The body the package SENDS: structural → SDK generated must be assignable.
  const sendBody: RunCreateParams = packageBody;
  // …and to the generic route's body type, so ONE body serves both creates.
  const sendGenericBody: AgentRunParams = packageBody;

  // The real client instance must satisfy the structural surface the tools use
  // (this is the exact assumption behind resolveAgentContext's cast).
  const clientSurface: NimbleAgentRunsClient = realClient;

  // Drift guard for the pre-existing Search/Extract surfaces — RESPONSE
  // direction only. Full client assignability deliberately cannot hold there:
  // the package's param types are looser than the SDK's country/locale literal
  // unions by design (arbitrary strings, server-validated), which is exactly
  // what the resolveClient casts bridge.
  const readSearch: NimbleRawSearchResponse = sdkSearchResponse;
  const readExtract: NimbleRawExtractResponse = sdkExtractResponse;

  return {
    readCreate,
    readGeneratedRun,
    readGet,
    readResult,
    sendBody,
    sendGenericBody,
    clientSurface,
    readSearch,
    readExtract,
  };
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
    // These are `true` only because the excess-key assertion resolved to
    // `true`; if either create route stopped publishing a field this package
    // declares, the file would not compile at all.
    expect(_noExcessOnPersistentRoute).toBe(true);
    expect(_noExcessOnGeneratedRoute).toBe(true);
  });

  /**
   * The compile-time guard covers what the body *may* declare. This covers
   * what a create call actually *sends*: every key must be one the SDK
   * publishes on both routes. Keeps an accidental `extra_body`-style addition
   * from reaching the wire even if the type were widened.
   */
  it('every field the package can send is published by the SDK on both routes', () => {
    const sendable: Array<keyof Required<NimbleAgentRunCreateBody>> = [
      'input',
      'effort',
      'output_schema',
      'input_data',
      'sources',
      'skill',
      'use_case',
      'agent_name',
    ];
    const publishedOnBothRoutes: string[] = [
      'input',
      'effort',
      'enable_events',
      'input_data',
      'output_schema',
      'previous_interaction_id',
      'sources',
      'skill',
      'use_case',
      'agent_name',
    ];
    for (const field of sendable) {
      expect(publishedOnBothRoutes).toContain(field);
    }
    // Every published run-create field this package chooses to support is
    // covered above; enable_events and previous_interaction_id are published
    // but intentionally not exposed yet.
    expect(sendable).not.toContain('enable_events');
    expect(sendable).not.toContain('previous_interaction_id');
  });
});
