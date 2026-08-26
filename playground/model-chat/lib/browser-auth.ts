export function csrfTokenFromCookie(cookie: string): string | undefined {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('nimble_playground_csrf='))
    ?.slice('nimble_playground_csrf='.length);
}
