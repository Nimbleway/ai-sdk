import type {
  NimbleAgentRawFailedResult,
  NimbleAgentRawResult,
  NimbleAgentRawRun,
  NimbleAgentRequestOptions,
  NimbleAgentRunCreateBody,
  NimbleAgentRunsClient,
  NimbleAgentTrust,
} from '../src/agent-schemas';

export const RUN_ID = 'task_run_11111111-2222-4333-8444-555555555555';
export const AGENT_ID = 'wsa_deadbeef-0000-4000-8000-000000000001';

export function rawRun(over: Partial<NimbleAgentRawRun> = {}): NimbleAgentRawRun {
  return {
    id: RUN_ID,
    interaction_id: 'int_0001',
    status: 'queued',
    is_active: true,
    effort: 'low',
    created_at: '2026-07-22T10:00:00Z',
    web_search_agent_id: AGENT_ID,
    ...over,
  };
}

/** Trust for a prose answer: callout-keyed claims with verbatim excerpts. */
export function textTrust(): NimbleAgentTrust {
  return {
    confidence: 'high',
    reasoning: 'Multiple primary sources agree.',
    sources: [
      {
        url: 'https://example.org/report',
        type: 'primary',
        title: 'Primary Report',
        source_category: 'official',
      },
      { url: 'https://news.example.com/coverage', type: 'secondary', source_category: 'news' },
    ],
    claims: [
      {
        callout: 1,
        confidence: 'high',
        reasoning: 'Stated verbatim in the primary source.',
        citations: [
          {
            url: 'https://example.org/report',
            title: 'Primary Report',
            excerpts: ['the verbatim supporting line'],
            source_type: 'primary',
          },
        ],
      },
    ],
  };
}

/** Trust for a structured answer: JSON-path-keyed claims. */
export function jsonTrust(): NimbleAgentTrust {
  return {
    confidence: 'medium',
    reasoning: 'Secondary sources only.',
    sources: [{ url: 'https://example.com/data', type: 'secondary' }],
    claims: [
      {
        path: '$.company.founded',
        confidence: 'medium',
        reasoning: 'One secondary source.',
        citations: [{ url: 'https://example.com/data', excerpts: ['founded in 2016'] }],
      },
    ],
  };
}

export function completedRun(over: Partial<NimbleAgentRawRun> = {}): NimbleAgentRawRun {
  return rawRun({
    status: 'completed',
    is_active: false,
    started_at: '2026-07-22T10:00:05Z',
    completed_at: '2026-07-22T10:02:00Z',
    ...over,
  });
}

export function completedTextResult(): NimbleAgentRawResult {
  return {
    run: completedRun(),
    output: { type: 'text', content: 'Answer with a cited claim.[1]', trust: textTrust() },
  };
}

export function completedJsonResult(): NimbleAgentRawResult {
  return {
    run: completedRun(),
    output: {
      type: 'json',
      content: { company: { name: 'Example Corp', founded: 2016 } },
      trust: jsonTrust(),
    },
  };
}

export function failedResult(
  status: 'failed' | 'cancelled' = 'failed',
  message = 'The research graph hit an unrecoverable provider error.',
): NimbleAgentRawFailedResult {
  return {
    run: rawRun({ status, is_active: false, error: { message, ref_id: RUN_ID } }),
    error: { message, ref_id: RUN_ID },
  };
}

/** An SDK-style HTTP error: a plain Error carrying `status` (+ parsed body). */
export function httpError(status: number, message: string, body?: unknown): Error {
  return Object.assign(new Error(message), {
    status,
    ...(body !== undefined ? { error: body } : {}),
  });
}

export interface RecordedCalls {
  /** Persistent-agent create: `POST /v2/agents/{agent_id}/runs`. */
  create: Array<{
    agentId: string;
    body: NimbleAgentRunCreateBody;
    options?: NimbleAgentRequestOptions;
  }>;
  /** Generated-agent create: `POST /v2/agents/runs`. */
  run: Array<{
    body: NimbleAgentRunCreateBody;
    options?: NimbleAgentRequestOptions;
  }>;
  get: Array<{
    runId: string;
    params: { agent_id: string };
    options?: NimbleAgentRequestOptions;
  }>;
  result: Array<{
    runId: string;
    params: { agent_id: string };
    options?: NimbleAgentRequestOptions;
  }>;
}

/**
 * A scriptable mock of the SDK's agents.runs surface. `gets` is consumed in
 * order (the last entry repeats — convenient for polling scripts); an `Error`
 * entry is thrown instead of returned.
 */
export function scriptedRunsClient(
  script: {
    create?: NimbleAgentRawRun | Error;
    /** Response for the generated-agent route; falls back to `create`. */
    run?: NimbleAgentRawRun | Error;
    gets?: Array<NimbleAgentRawRun | Error>;
    result?: NimbleAgentRawResult | NimbleAgentRawFailedResult | Error;
  } = {},
): { client: NimbleAgentRunsClient; calls: RecordedCalls } {
  const calls: RecordedCalls = { create: [], run: [], get: [], result: [] };
  const gets = script.gets ? [...script.gets] : [];
  const client: NimbleAgentRunsClient = {
    agents: {
      run: async (body, options) => {
        calls.run.push({ body, options });
        const entry = script.run ?? script.create ?? rawRun();
        if (entry instanceof Error) throw entry;
        return entry;
      },
      runs: {
        create: async (agentId, body, options) => {
          calls.create.push({ agentId, body, options });
          const entry = script.create ?? rawRun();
          if (entry instanceof Error) throw entry;
          return entry;
        },
        get: async (runId, params, options) => {
          calls.get.push({ runId, params, options });
          const entry = (gets.length > 1 ? gets.shift() : gets[0]) ?? rawRun();
          if (entry instanceof Error) throw entry;
          return entry;
        },
        result: async (runId, params, options) => {
          calls.result.push({ runId, params, options });
          const entry = script.result ?? completedTextResult();
          if (entry instanceof Error) throw entry;
          return entry;
        },
      },
    },
  };
  return { client, calls };
}
