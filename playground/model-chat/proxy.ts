import { NextResponse, type NextRequest } from 'next/server';
import { isGatewayAuthorized } from './lib/gateway-auth';

export async function proxy(request: NextRequest) {
  if (await isGatewayAuthorized(request)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  return new NextResponse('Not found.', { status: 404 });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
