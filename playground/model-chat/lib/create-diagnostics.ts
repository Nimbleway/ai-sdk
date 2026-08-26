export const CREATE_DIAGNOSTIC_SCHEMA = 'start-research-create/v1' as const;
export const CREATE_DIAGNOSTIC_INTERNAL_PATH = '/__internal/create-diagnostic';
export const CREATE_DIAGNOSTIC_READ_PATH = '/__auth/create-diagnostic';
export const CREATE_DIAGNOSTIC_RETENTION_SECONDS = 10 * 60;

export type CreateDiagnosticPhase =
  | 'pre_network_rejection'
  | 'outbound_post_attempt'
  | 'provider_response'
  | 'transport_ambiguity';

export type CreateDiagnosticLocalReason =
  | 'schema_validation'
  | 'input_data_without_schema'
  | 'sdk_local_rejection';

export type CreateDiagnosticEvent = {
  schema: typeof CREATE_DIAGNOSTIC_SCHEMA;
  correlationId: string;
  phase: CreateDiagnosticPhase;
  providerPostAttempted: boolean;
  providerResponseReceived: boolean;
  retryCreateAutomatically: false;
  localReason?: CreateDiagnosticLocalReason;
  httpStatus?: number;
};

export type CreateDiagnosticReceipt = CreateDiagnosticEvent & {
  observedAt: number;
  expiresAt: number;
};

export type CreateDiagnosticReadOutcome =
  | {
      kind: 'receipt';
      correlationId: string;
      receipt: CreateDiagnosticReceipt;
    }
  | {
      kind: 'none' | 'unread';
      correlationId: string;
    };

type CreateDiagnosticCallbackPayload = {
  v: 1;
  aud: string;
  iat: number;
  exp: number;
  sidDigest: string;
  correlationId: string;
  sequence: number;
  action: 'record' | 'clear';
  event?: CreateDiagnosticEvent;
};

export type CreateDiagnosticCallbackBody = {
  payload: string;
  signature: string;
};

export type VerifiedCreateDiagnosticCallback = {
  sidDigest: string;
  correlationId: string;
  sequence: number;
  action: 'record' | 'clear';
  event?: CreateDiagnosticEvent;
};

export type CreateDiagnosticReporter = {
  correlationId: string;
  baseFetch: typeof fetch;
  report(event: CreateDiagnosticEvent): Promise<boolean>;
  clear(): Promise<boolean>;
};

const encoder = new TextEncoder();
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SID = /^[A-Za-z0-9_-]{43}$/;

const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

async function digest(value: string): Promise<string> {
  return b64(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
  );
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(`create-diagnostic\n${value}`),
      ),
    ),
  );
}

function same(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const keys = Object.keys(value).sort();
  const allowed = [...required, ...optional];
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.includes(key))
  );
}

export function validChatRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

export function validCreateDiagnosticEvent(
  value: unknown,
): value is CreateDiagnosticEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (
    !exactKeys(
      event,
      [
        'schema',
        'correlationId',
        'phase',
        'providerPostAttempted',
        'providerResponseReceived',
        'retryCreateAutomatically',
      ],
      ['localReason', 'httpStatus'],
    ) ||
    event.schema !== CREATE_DIAGNOSTIC_SCHEMA ||
    !validChatRequestId(event.correlationId) ||
    ![
      'pre_network_rejection',
      'outbound_post_attempt',
      'provider_response',
      'transport_ambiguity',
    ].includes(String(event.phase)) ||
    typeof event.providerPostAttempted !== 'boolean' ||
    typeof event.providerResponseReceived !== 'boolean' ||
    event.retryCreateAutomatically !== false
  ) {
    return false;
  }

  if (
    event.localReason !== undefined &&
    ![
      'schema_validation',
      'input_data_without_schema',
      'sdk_local_rejection',
    ].includes(String(event.localReason))
  ) {
    return false;
  }
  if (
    event.httpStatus !== undefined &&
    (!Number.isInteger(event.httpStatus) ||
      Number(event.httpStatus) < 100 ||
      Number(event.httpStatus) > 599)
  ) {
    return false;
  }
  if (event.phase === 'pre_network_rejection') {
    return (
      event.providerPostAttempted === false &&
      event.providerResponseReceived === false &&
      event.localReason !== undefined &&
      event.httpStatus === undefined
    );
  }
  if (event.phase === 'outbound_post_attempt') {
    return (
      event.providerPostAttempted === true &&
      event.providerResponseReceived === false &&
      event.localReason === undefined &&
      event.httpStatus === undefined
    );
  }
  if (event.phase === 'provider_response') {
    return (
      event.providerPostAttempted === true &&
      event.providerResponseReceived === true &&
      event.localReason === undefined &&
      event.httpStatus !== undefined
    );
  }
  return (
    event.providerPostAttempted === true &&
    event.providerResponseReceived === false &&
    event.localReason === undefined &&
    event.httpStatus === undefined
  );
}

export function validCreateDiagnosticReceipt(
  value: unknown,
): value is CreateDiagnosticReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (
    !exactKeys(
      receipt,
      [
        'schema',
        'correlationId',
        'phase',
        'providerPostAttempted',
        'providerResponseReceived',
        'retryCreateAutomatically',
        'observedAt',
        'expiresAt',
      ],
      ['localReason', 'httpStatus'],
    ) ||
    !Number.isInteger(receipt.observedAt) ||
    !Number.isInteger(receipt.expiresAt) ||
    Number(receipt.observedAt) <= 0 ||
    Number(receipt.expiresAt) <= Number(receipt.observedAt) ||
    Number(receipt.expiresAt) >
      Number(receipt.observedAt) + CREATE_DIAGNOSTIC_RETENTION_SECONDS
  ) {
    return false;
  }
  const {
    observedAt: _observedAt,
    expiresAt: _expiresAt,
    ...event
  } = receipt;
  return validCreateDiagnosticEvent(event);
}

export function classifyCreateDiagnosticRead(input: {
  correlationId: string;
  httpStatus: number;
  body?: unknown;
}): CreateDiagnosticReadOutcome {
  if (input.httpStatus === 204) {
    return { kind: 'none', correlationId: input.correlationId };
  }
  if (
    input.httpStatus !== 200 ||
    !input.body ||
    typeof input.body !== 'object' ||
    Array.isArray(input.body)
  ) {
    return { kind: 'unread', correlationId: input.correlationId };
  }
  const body = input.body as Record<string, unknown>;
  if (
    !exactKeys(body, ['diagnostic']) ||
    !validCreateDiagnosticReceipt(body.diagnostic) ||
    body.diagnostic.correlationId !== input.correlationId
  ) {
    return { kind: 'unread', correlationId: input.correlationId };
  }
  return {
    kind: 'receipt',
    correlationId: input.correlationId,
    receipt: body.diagnostic,
  };
}

export function createDiagnosticEvent(
  input:
    | {
        correlationId: string;
        phase: 'pre_network_rejection';
        localReason: CreateDiagnosticLocalReason;
      }
    | {
        correlationId: string;
        phase: 'outbound_post_attempt' | 'transport_ambiguity';
      }
    | {
        correlationId: string;
        phase: 'provider_response';
        httpStatus: number;
      },
): CreateDiagnosticEvent {
  const event: CreateDiagnosticEvent = {
    schema: CREATE_DIAGNOSTIC_SCHEMA,
    correlationId: input.correlationId,
    phase: input.phase,
    providerPostAttempted: input.phase !== 'pre_network_rejection',
    providerResponseReceived: input.phase === 'provider_response',
    retryCreateAutomatically: false,
    ...('localReason' in input ? { localReason: input.localReason } : {}),
    ...('httpStatus' in input ? { httpStatus: input.httpStatus } : {}),
  };
  if (!validCreateDiagnosticEvent(event)) {
    throw new Error('Invalid create diagnostic event.');
  }
  return event;
}

function callbackPayload(value: unknown): CreateDiagnosticCallbackPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    !exactKeys(
      payload,
      [
        'v',
        'aud',
        'iat',
        'exp',
        'sidDigest',
        'correlationId',
        'sequence',
        'action',
      ],
      ['event'],
    ) ||
    payload.v !== 1 ||
    typeof payload.aud !== 'string' ||
    !payload.aud ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    typeof payload.sidDigest !== 'string' ||
    !SID.test(payload.sidDigest) ||
    !validChatRequestId(payload.correlationId) ||
    !Number.isInteger(payload.sequence) ||
    Number(payload.sequence) < 1 ||
    Number(payload.sequence) > 64 ||
    !['record', 'clear'].includes(String(payload.action))
  ) {
    return null;
  }
  if (
    (payload.action === 'record' &&
      (!validCreateDiagnosticEvent(payload.event) ||
        payload.event.correlationId !== payload.correlationId)) ||
    (payload.action === 'clear' && payload.event !== undefined)
  ) {
    return null;
  }
  return payload as CreateDiagnosticCallbackPayload;
}

export async function createDiagnosticCallbackBody(input: {
  secret: string;
  audience: string;
  sid: string;
  correlationId: string;
  sequence: number;
  action: 'record' | 'clear';
  event?: CreateDiagnosticEvent;
  now?: number;
}): Promise<CreateDiagnosticCallbackBody> {
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  if (
    !input.secret ||
    !input.audience ||
    !SID.test(input.sid) ||
    !validChatRequestId(input.correlationId) ||
    !Number.isInteger(input.sequence) ||
    input.sequence < 1 ||
    input.sequence > 64 ||
    (input.action === 'record' &&
      (!validCreateDiagnosticEvent(input.event) ||
        input.event.correlationId !== input.correlationId)) ||
    (input.action === 'clear' && input.event !== undefined)
  ) {
    throw new Error('Invalid create diagnostic callback.');
  }
  const payload = JSON.stringify({
    v: 1,
    aud: input.audience,
    iat: now,
    exp: now + 30,
    sidDigest: await digest(input.sid),
    correlationId: input.correlationId,
    sequence: input.sequence,
    action: input.action,
    ...(input.event ? { event: input.event } : {}),
  } satisfies CreateDiagnosticCallbackPayload);
  return {
    payload,
    signature: await hmac(input.secret, payload),
  };
}

export async function verifyDiagnosticCallbackBody(input: {
  body: unknown;
  secret: string;
  audience: string;
  now?: number;
}): Promise<VerifiedCreateDiagnosticCallback | null> {
  if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
    return null;
  }
  const body = input.body as Record<string, unknown>;
  if (
    !exactKeys(body, ['payload', 'signature']) ||
    typeof body.payload !== 'string' ||
    body.payload.length > 2_048 ||
    typeof body.signature !== 'string' ||
    !SID.test(body.signature)
  ) {
    return null;
  }
  if (!same(body.signature, await hmac(input.secret, body.payload))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.payload);
  } catch {
    return null;
  }
  const payload = callbackPayload(parsed);
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  if (
    !payload ||
    payload.aud !== input.audience ||
    payload.iat > now + 5 ||
    payload.iat < now - 30 ||
    payload.exp <= now ||
    payload.exp > payload.iat + 30
  ) {
    return null;
  }
  return {
    sidDigest: payload.sidDigest,
    correlationId: payload.correlationId,
    sequence: payload.sequence,
    action: payload.action,
    ...(payload.event ? { event: payload.event } : {}),
  };
}

export function sanitizedCreateDiagnosticError(
  event: CreateDiagnosticEvent,
): Error {
  return new Error(
    `Nimble create stopped. Diagnostic ${JSON.stringify(event)}`,
  );
}

export function createDiagnosticReporter(input: {
  secret: string;
  audience: string;
  sid: string;
  correlationId: string;
  baseFetch?: typeof fetch;
}): CreateDiagnosticReporter {
  const baseFetch = input.baseFetch ?? globalThis.fetch;
  if (
    !input.secret ||
    !input.audience ||
    !SID.test(input.sid) ||
    !validChatRequestId(input.correlationId)
  ) {
    throw new Error('Invalid create diagnostic reporter configuration.');
  }
  let sequence = 0;
  const send = async (
    action: 'record' | 'clear',
    event?: CreateDiagnosticEvent,
  ): Promise<boolean> => {
    if (
      (action === 'record' &&
        (!validCreateDiagnosticEvent(event) ||
          event.correlationId !== input.correlationId)) ||
      (action === 'clear' && event !== undefined)
    ) {
      return false;
    }
    try {
      sequence += 1;
      const body = await createDiagnosticCallbackBody({
        secret: input.secret,
        audience: input.audience,
        sid: input.sid,
        correlationId: input.correlationId,
        sequence,
        action,
        event,
      });
      const response = await baseFetch(
        `https://${input.audience}${CREATE_DIAGNOSTIC_INTERNAL_PATH}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(2_000),
        },
      );
      return response.status === 204;
    } catch {
      return false;
    }
  };
  return {
    correlationId: input.correlationId,
    baseFetch,
    report: (event) => send('record', event),
    clear: () => send('clear'),
  };
}
