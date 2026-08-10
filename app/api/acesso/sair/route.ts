import { cookies } from 'next/headers';
import { COOKIE_ACESSO, naoAutorizado, origemInvalida, origemPermitida, temAcesso } from '@/lib/acesso';

export async function POST(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();

  const jarro = await cookies();
  jarro.delete(COOKIE_ACESSO);
  return Response.json({ ok: true });
}
