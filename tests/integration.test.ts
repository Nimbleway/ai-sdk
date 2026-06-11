import { describe, it, expect } from 'vitest';
import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { nimbleSearch } from '../src/nimble-search';
import { serpResult, searchResponse, mockNimbleClient } from './fixtures';

/**
 * Integration: drive the *real* AI SDK `generateText` tool-calling loop with a
 * mock LLM (no provider) and a mock Nimble client (no live key). Proves the
 * package behaves as a real AI SDK tool plugin: the model emits a tool call,
 * the SDK validates the input against our zod schema, runs our `execute()`,
 * and feeds the normalized result back into the next model step.
 */
describe('AI SDK plugin integration (generateText loop)', () => {
  it('the model calls nimbleSearch and receives normalized results', async () => {
    const { client, calls } = mockNimbleClient(
      searchResponse([
        serpResult({ title: 'Nimble v0.18', url: 'https://nimbleway.com/blog/v018' }),
      ]),
    );

    // The exact V3 generate-result shape, derived from the mock's own type.
    type GenResult = Awaited<
      ReturnType<InstanceType<typeof MockLanguageModelV3>['doGenerate']>
    >;

    const usage: GenResult['usage'] = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    };

    const toolCallStep: GenResult = {
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'webSearch',
          input: JSON.stringify({ query: 'latest nimble release' }),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
      warnings: [],
    };
    const answerStep: GenResult = {
      content: [{ type: 'text', text: 'The latest release is v0.18 (nimbleway.com).' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    };

    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => (++step === 1 ? toolCallStep : answerStep),
    });

    const result = await generateText({
      model,
      prompt: 'What is the latest Nimble release?',
      tools: { webSearch: nimbleSearch({ client }) },
      stopWhen: stepCountIs(3),
    });

    // Our tool's execute ran against the mocked Nimble client.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toBe('latest nimble release');
    expect(calls[0]!.focus).toBe('general');

    // The SDK captured the normalized tool output (in the tool-call step).
    const toolResults = result.steps.flatMap((s) => s.toolResults) as Array<{ output: unknown }>;
    expect(toolResults).toHaveLength(1);
    const output = toolResults[0]!.output as {
      results: Array<{ url: string; title: string }>;
    };
    expect(output.results[0]!.url).toBe('https://nimbleway.com/blog/v018');

    // The loop completed with the model's final answer.
    expect(result.text).toContain('v0.18');
    expect(result.steps.length).toBeGreaterThanOrEqual(2);
  });
});
