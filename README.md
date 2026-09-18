# Buscador Bling PRO

Aplicação Next.js para enriquecer, revisar e enviar produtos ao Bling, com histórico no Supabase e notificações opcionais pelo Telegram.

## Desenvolvimento local

1. Instale as dependências com `npm ci`.
2. Copie `.env.example` para `.env.local` e preencha as variáveis.
3. Execute `npm run dev`.
4. Antes de publicar, execute `npm run lint` e `npm run build`.

## Acesso e troca da senha

A senha não fica salva no GitHub. Ela é lida da variável `APP_ACCESS_PASSWORD` no ambiente da Vercel.

Para trocar uma senha esquecida:

1. Abra o projeto no painel da Vercel.
2. Entre em **Settings → Environment Variables**.
3. altere `APP_ACCESS_PASSWORD` para uma senha nova com pelo menos 10 caracteres.
4. Confirme que `APP_SESSION_SECRET` existe e possui pelo menos 32 caracteres. Não reutilize a senha nesse campo.
5. Faça um novo deploy para aplicar as mudanças.

Ao alterar `APP_SESSION_SECRET`, todas as sessões existentes são encerradas. Nunca grave senhas, tokens ou chaves reais no repositório.

## Variáveis obrigatórias

| Variável | Uso |
| --- | --- |
| `APP_ACCESS_PASSWORD` | Senha de entrada da aplicação; mínimo de 10 caracteres. |
| `APP_SESSION_SECRET` | Assinatura da sessão; mínimo de 32 caracteres. |
| `BLING_CLIENT_ID` | Identificador OAuth do aplicativo Bling. |
| `BLING_CLIENT_SECRET` | Segredo OAuth do aplicativo Bling. |
| `SUPABASE_URL` | URL do projeto Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave de serviço usada apenas no servidor. |

`TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` são opcionais e ativam as notificações.
