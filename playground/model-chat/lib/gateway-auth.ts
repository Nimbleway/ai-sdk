export const GATEWAY_HEADER = 'x-playground-gateway-auth';

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function isGatewayAuthorized(request: Request): boolean {
  const expected = process.env.PLAYGROUND_GATEWAY_SECRET?.trim();
  const supplied = request.headers.get(GATEWAY_HEADER)?.trim();
  return Boolean(expected && supplied && constantTimeEqual(expected, supplied));
}
