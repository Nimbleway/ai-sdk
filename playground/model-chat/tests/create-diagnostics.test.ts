import { describe, expect, it, vi } from 'vitest';
import {
  classifyCreateDiagnosticRead,
  CREATE_DIAGNOSTIC_SCHEMA,
  createDiagnosticCallbackBody,
  createDiagnosticEvent,
  createDiagnosticReporter,
  sanitizedCreateDiagnosticError,
  validCreateDiagnosticEvent,
  validCreateDiagnosticReceipt,
  verifyDiagnosticCallbackBody,
  type CreateDiagnosticEvent,
} from '../lib/create-diagnostics';
import {
  handleCreateDiagnosticCallback,
  normalizeModelRuntime,
  type CreateDiagnosticState,
} from '../cloudflare/src/gateway';

const NOW = 1_800_000_000;
const SECRET = 'fixed-origin-secret';
const AUDIENCE = 'playground.test';
const SID = 'S'.repeat(43);
const CORRELATION_ID = 'c9b7ff04-3c76-4f68-8d8b-2ccdbf07cb60';
const OTHER_CORRELATION_ID = '8a9b3cc2-6998-4a55-b41d-bc6a0a5c6f9f';

function callbackState() {
  return {
    state: {
      recordCreateDiagnostic: vi.fn(async () => true),
      clearCreateDiagnostic: vi.fn(async () => true),
    } satisfies CreateDiagnosticState,
  };
}

describe('create diagnostic DTO', () => {
  it('uses an exact scalar allowlist and rejects secret-bearing extensions', () => {
    const event = createDiagnosticEvent({
      correlationId: CORRELATION_ID,
      phase: 'provider_response',
      httpStatus: 422,
    });

    expect(event).toEqual({
      schema: CREATE_DIAGNOSTIC_SCHEMA,
      correlationId: CORRELATION_ID,
      phase: 'provider_response',
      providerPostAttempted: true,
      providerResponseReceived: true,
      retryCreateAutomatically: false,
      httpStatus: 422,
    });
    expect(Object.keys(event).sort()).toEqual([
      'correlationId',
      'httpStatus',
      'phase',
      'providerPostAttempted',
      'providerResponseReceived',
      'retryCreateAutomatically',
      'schema',
    ]);
    expect(validCreateDiagnosticEvent(event)).toBe(true);
    expect(
      validCreateDiagnosticReceipt({
        ...event,
        observedAt: NOW,
        expiresAt: NOW + 60,
      }),
    ).toBe(true);
    expect(
      validCreateDiagnosticReceipt({
        ...event,
        observedAt: NOW,
        expiresAt: NOW,
      }),
    ).toBe(false);
    expect(
      validCreateDiagnosticReceipt({
        ...event,
        observedAt: NOW,
        expiresAt: NOW + 601,
      }),
    ).toBe(false);
    expect(
      validCreateDiagnosticReceipt({
        ...event,
        observedAt: NOW,
        expiresAt: NOW + 60,
        request: 'private-prompt-canary',
      }),
    ).toBe(false);

    const canaries = {
      apiKey: 'nimble-secret-canary',
      authorization: 'Bearer browser-secret-canary',
      cookie: 'session=browser-secret-canary',
      task: 'private-prompt-canary',
      outputSchema: { private: 'schema-canary' },
      providerBody: { detail: 'provider-body-canary' },
      rawError: 'raw-error-canary',
      sid: SID,
    };
    for (const [field, value] of Object.entries(canaries)) {
      expect(validCreateDiagnosticEvent({ ...event, [field]: value })).toBe(false);
    }

    const rendered = JSON.stringify(event);
    for (const canary of [
      'nimble-secret-canary',
      'browser-secret-canary',
      'private-prompt-canary',
      'schema-canary',
      'provider-body-canary',
      'raw-error-canary',
      SID,
    ]) {
      expect(rendered).not.toContain(canary);
    }
  });

  it('renders only the validated diagnostic event in public tool errors', () => {
    const event = createDiagnosticEvent({
      correlationId: CORRELATION_ID,
      phase: 'transport_ambiguity',
    });
    const error = sanitizedCreateDiagnosticError(event);

    expect(error.message).toContain(CORRELATION_ID);
    expect(error.message).toContain('"phase":"transport_ambiguity"');
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(SID);
  });

  it('distinguishes a receipt, authenticated absence, and an unread result', () => {
    const receipt = {
      ...createDiagnosticEvent({
        correlationId: CORRELATION_ID,
        phase: 'transport_ambiguity',
      }),
      observedAt: NOW,
      expiresAt: NOW + 60,
    };

    expect(
      classifyCreateDiagnosticRead({
        correlationId: CORRELATION_ID,
        httpStatus: 200,
        body: { diagnostic: receipt },
      }),
    ).toEqual({
      kind: 'receipt',
      correlationId: CORRELATION_ID,
      receipt,
    });
    expect(
      classifyCreateDiagnosticRead({
        correlationId: CORRELATION_ID,
        httpStatus: 204,
      }),
    ).toEqual({ kind: 'none', correlationId: CORRELATION_ID });
    for (const input of [
      { httpStatus: 404 },
      { httpStatus: 500 },
      { httpStatus: 200, body: { diagnostic: { ...receipt, apiKey: 'canary' } } },
      {
        httpStatus: 200,
        body: {
          diagnostic: {
            ...receipt,
            correlationId: OTHER_CORRELATION_ID,
          },
        },
      },
      {
        httpStatus: 200,
        body: { diagnostic: receipt, extra: 'provider-prose-canary' },
      },
    ]) {
      expect(
        classifyCreateDiagnosticRead({
          correlationId: CORRELATION_ID,
          ...input,
        }),
      ).toEqual({ kind: 'unread', correlationId: CORRELATION_ID });
    }
  });
});

describe('create diagnostic callback authentication', () => {
  it('assigns monotonic sequence numbers to record and clear callbacks', async () => {
    const callbackBodies: unknown[] = [];
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callbackBodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    });
    const reporter = createDiagnosticReporter({
      secret: SECRET,
      audience: AUDIENCE,
      sid: SID,
      correlationId: CORRELATION_ID,
      baseFetch: baseFetch as unknown as typeof fetch,
    });

    await expect(
      reporter.report(
        createDiagnosticEvent({
          correlationId: CORRELATION_ID,
          phase: 'outbound_post_attempt',
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      reporter.report(
        createDiagnosticEvent({
          correlationId: CORRELATION_ID,
          phase: 'transport_ambiguity',
        }),
      ),
    ).resolves.toBe(true);
    await expect(reporter.clear()).resolves.toBe(true);

    const now = Math.floor(Date.now() / 1_000);
    const verified = await Promise.all(
      callbackBodies.map((body) =>
        verifyDiagnosticCallbackBody({
          body,
          secret: SECRET,
          audience: AUDIENCE,
          now,
        }),
      ),
    );
    expect(verified.map((callback) => callback?.sequence)).toEqual([1, 2, 3]);
    expect(verified.map((callback) => callback?.action)).toEqual([
      'record',
      'record',
      'clear',
    ]);
    expect(baseFetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(callbackBodies)).not.toContain(SECRET);
    expect(JSON.stringify(callbackBodies)).not.toContain(SID);
  });

  it('HMAC-authenticates a record callback and preserves correlation exactly', async () => {
    const event = createDiagnosticEvent({
      correlationId: CORRELATION_ID,
      phase: 'provider_response',
      httpStatus: 422,
    });
    const body = await createDiagnosticCallbackBody({
      secret: SECRET,
      audience: AUDIENCE,
      sid: SID,
      correlationId: CORRELATION_ID,
      sequence: 1,
      action: 'record',
      event,
      now: NOW,
    });

    expect(Object.keys(body).sort()).toEqual(['payload', 'signature']);
    expect(body.payload).not.toContain(SECRET);
    expect(body.payload).not.toContain(SID);
    const verified = await verifyDiagnosticCallbackBody({
      body,
      secret: SECRET,
      audience: AUDIENCE,
      now: NOW,
    });
    expect(verified).toEqual({
      sidDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      correlationId: CORRELATION_ID,
      sequence: 1,
      action: 'record',
      event,
    });

    const { state } = callbackState();
    const response = await handleCreateDiagnosticCallback(
      body,
      normalizeModelRuntime({
        AUTH_RP_ID: AUDIENCE,
        PLAYGROUND_GATEWAY_SECRET: SECRET,
      }),
      state,
      NOW,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(state.recordCreateDiagnostic).toHaveBeenCalledOnce();
    expect(state.recordCreateDiagnostic).toHaveBeenCalledWith(
      verified!.sidDigest,
      CORRELATION_ID,
      1,
      event,
      NOW,
    );
    expect(state.clearCreateDiagnostic).not.toHaveBeenCalled();
  });

  it('HMAC-authenticates a clear callback without accepting an event', async () => {
    const body = await createDiagnosticCallbackBody({
      secret: SECRET,
      audience: AUDIENCE,
      sid: SID,
      correlationId: CORRELATION_ID,
      sequence: 2,
      action: 'clear',
      now: NOW,
    });
    const verified = await verifyDiagnosticCallbackBody({
      body,
      secret: SECRET,
      audience: AUDIENCE,
      now: NOW,
    });
    expect(verified).toEqual({
      sidDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      correlationId: CORRELATION_ID,
      sequence: 2,
      action: 'clear',
    });

    const { state } = callbackState();
    const response = await handleCreateDiagnosticCallback(
      body,
      normalizeModelRuntime({
        AUTH_RP_ID: AUDIENCE,
        PLAYGROUND_GATEWAY_SECRET: SECRET,
      }),
      state,
      NOW,
    );
    expect(response.status).toBe(204);
    expect(state.clearCreateDiagnostic).toHaveBeenCalledWith(
      verified!.sidDigest,
      CORRELATION_ID,
      2,
      NOW,
    );
    expect(state.recordCreateDiagnostic).not.toHaveBeenCalled();
  });

  it('rejects tampering, stale or wrong-audience callbacks, and correlation mismatch', async () => {
    const event = createDiagnosticEvent({
      correlationId: CORRELATION_ID,
      phase: 'pre_network_rejection',
      localReason: 'schema_validation',
    });
    const body = await createDiagnosticCallbackBody({
      secret: SECRET,
      audience: AUDIENCE,
      sid: SID,
      correlationId: CORRELATION_ID,
      sequence: 1,
      action: 'record',
      event,
      now: NOW,
    });

    await expect(
      createDiagnosticCallbackBody({
        secret: SECRET,
        audience: AUDIENCE,
        sid: SID,
        correlationId: OTHER_CORRELATION_ID,
        sequence: 1,
        action: 'record',
        event,
        now: NOW,
      }),
    ).rejects.toThrow(/Invalid create diagnostic callback/);

    const tampered = {
      ...body,
      payload: body.payload.replace(CORRELATION_ID, OTHER_CORRELATION_ID),
    };
    await expect(
      verifyDiagnosticCallbackBody({
        body: tampered,
        secret: SECRET,
        audience: AUDIENCE,
        now: NOW,
      }),
    ).resolves.toBeNull();
    await expect(
      verifyDiagnosticCallbackBody({
        body,
        secret: SECRET,
        audience: 'other.test',
        now: NOW,
      }),
    ).resolves.toBeNull();
    await expect(
      verifyDiagnosticCallbackBody({
        body,
        secret: SECRET,
        audience: AUDIENCE,
        now: NOW + 31,
      }),
    ).resolves.toBeNull();

    const { state } = callbackState();
    const response = await handleCreateDiagnosticCallback(
      tampered,
      normalizeModelRuntime({
        AUTH_RP_ID: AUDIENCE,
        PLAYGROUND_GATEWAY_SECRET: SECRET,
      }),
      state,
      NOW,
    );
    expect(response.status).toBe(404);
    expect(state.recordCreateDiagnostic).not.toHaveBeenCalled();
    expect(state.clearCreateDiagnostic).not.toHaveBeenCalled();
  });

  it('rejects callback bodies with non-allowlisted outer fields', async () => {
    const event: CreateDiagnosticEvent = createDiagnosticEvent({
      correlationId: CORRELATION_ID,
      phase: 'outbound_post_attempt',
    });
    const body = await createDiagnosticCallbackBody({
      secret: SECRET,
      audience: AUDIENCE,
      sid: SID,
      correlationId: CORRELATION_ID,
      sequence: 1,
      action: 'record',
      event,
      now: NOW,
    });

    await expect(
      verifyDiagnosticCallbackBody({
        body: { ...body, apiKey: 'nimble-secret-canary' },
        secret: SECRET,
        audience: AUDIENCE,
        now: NOW,
      }),
    ).resolves.toBeNull();
  });
});
