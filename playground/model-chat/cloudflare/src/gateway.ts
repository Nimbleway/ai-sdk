export const ORIGIN_AUTH_HEADER = "x-playground-gateway-auth";

export function protectedUpstreamRequest(
  request: Request,
  originSecret: string,
  adminEmail: string,
): Request {
  const headers = new Headers(request.headers);
  // Strip all browser-controlled authorization material before adding the
  // server-only origin credential after session verification.
  headers.delete(ORIGIN_AUTH_HEADER);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("x-playground-auth-email");
  headers.set(ORIGIN_AUTH_HEADER, originSecret);
  headers.set("x-playground-auth-email", adminEmail);
  return new Request(request, { headers });
}
