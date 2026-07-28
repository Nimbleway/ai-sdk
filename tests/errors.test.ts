import { describe, it, expect } from 'vitest';
import { NimbleAgentRunError, NimbleConfigError, NimbleSearchError } from '../src/errors';

describe('errors', () => {
  it('NimbleConfigError is an Error with the right name', () => {
    const err = new NimbleConfigError('missing key');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NimbleConfigError');
    expect(err.message).toBe('missing key');
  });

  it('NimbleSearchError carries an optional status and cause', () => {
    const cause = new Error('upstream 429');
    const err = new NimbleSearchError('search failed', { status: 429, cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NimbleSearchError');
    expect(err.status).toBe(429);
    expect(err.cause).toBe(cause);
  });

  it('NimbleSearchError works without options', () => {
    const err = new NimbleSearchError('search failed');
    expect(err.status).toBeUndefined();
  });

  it('NimbleAgentRunError carries reason, run context, HTTP status, and cause', () => {
    const cause = new Error('boom');
    const err = new NimbleAgentRunError('run failed', {
      reason: 'failed',
      runId: 'task_run_x',
      agentId: 'wsa_y',
      runStatus: 'failed',
      status: 422,
      cause,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NimbleAgentRunError');
    expect(err.reason).toBe('failed');
    expect(err.runId).toBe('task_run_x');
    expect(err.agentId).toBe('wsa_y');
    expect(err.runStatus).toBe('failed');
    expect(err.status).toBe(422);
    expect(err.cause).toBe(cause);
  });

  it('NimbleAgentRunError works with only a reason', () => {
    const err = new NimbleAgentRunError('m', { reason: 'protocol' });
    expect(err.reason).toBe('protocol');
    expect(err.runId).toBeUndefined();
    expect(err.agentId).toBeUndefined();
    expect(err.status).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});
