import { describe, it, expect } from 'vitest';
import { NimbleConfigError, NimbleSearchError } from '../src/errors';

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
});
