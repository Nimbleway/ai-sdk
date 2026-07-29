export const GATEWAY_HEADER = 'x-playground-origin-assertion';

export type GatewayAssertion = {
  role: 'admin' | 'employee' | 'agent';
  sid: string;
  aud: string;
  iat: number;
  exp: number;
};

const encoder = new TextEncoder();

const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const unb64 = (value: string) => {
  const raw = atob(
    value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '='),
  );
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
};

async function signature(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function signGatewayAssertion(
  secret: string,
  claims: GatewayAssertion,
): Promise<string> {
  const encoded = b64(encoder.encode(JSON.stringify(claims)));
  return `${encoded}.${await signature(secret, encoded)}`;
}

export async function readGatewayAssertion(
  request: Request,
): Promise<GatewayAssertion | null> {
  const secret = process.env.PLAYGROUND_GATEWAY_SECRET?.trim();
  const audience = process.env.PLAYGROUND_GATEWAY_AUDIENCE?.trim();
  const supplied = request.headers.get(GATEWAY_HEADER)?.trim();
  if (!secret || !audience || !supplied || supplied.length > 2_048) return null;
  const [encoded, suppliedSignature] = supplied.split('.');
  if (
    !encoded ||
    !suppliedSignature ||
    !constantTimeEqual(await signature(secret, encoded), suppliedSignature)
  ) return null;

  let claims: GatewayAssertion;
  try {
    claims = JSON.parse(new TextDecoder().decode(unb64(encoded))) as GatewayAssertion;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1_000);
  if (
    !claims ||
    Object.keys(claims).sort().join(',') !== 'aud,exp,iat,role,sid' ||
    !['admin', 'employee', 'agent'].includes(claims.role) ||
    !/^[A-Za-z0-9_-]{43}$/.test(claims.sid) ||
    claims.aud !== audience ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.iat > now + 5 ||
    claims.iat < now - 30 ||
    claims.exp <= now ||
    claims.exp > claims.iat + 30
  ) return null;
  return claims;
}

export async function isGatewayAuthorized(request: Request): Promise<boolean> {
  return Boolean(await readGatewayAssertion(request));
}
