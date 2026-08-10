import { NextRequest, NextResponse } from 'next/server';
import { COOKIE_ACESSO, validarTokenSessao } from '@/lib/acesso';

const PUBLICOS = new Set(['/login', '/api/acesso/entrar']);

export function proxy(request: NextRequest) {
  const caminho = request.nextUrl.pathname;
  const autenticado = validarTokenSessao(request.cookies.get(COOKIE_ACESSO)?.value);

  if (caminho === '/login' && autenticado) {
    return NextResponse.redirect(new URL('/', request.url));
  }
  if (PUBLICOS.has(caminho)) return NextResponse.next();

  if (!autenticado) {
    if (caminho.startsWith('/api/')) {
      return NextResponse.json({ erro: 'Acesso não autorizado.' }, { status: 401 });
    }
    const login = new URL('/login', request.url);
    login.searchParams.set('retorno', `${caminho}${request.nextUrl.search}`);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
