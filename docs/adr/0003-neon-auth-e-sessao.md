# ADR 0003: Neon Auth como identidade, sessão própria no painel

Status: aceita.

## Contexto

O projeto Neon tem Auth gerenciado (Better Auth). O PRD exige MFA e passkeys desde o MVP, e o Auth gerenciado ainda não os oferece. O painel também usa SSE, que não envia cabeçalhos personalizados, então cookie de sessão é mais simples que token em memória.

## Decisão

- O navegador entra no Neon Auth (`@neon/auth`), obtém o JWT (15 minutos) e o troca em `POST /auth/neon/session` por um cookie `HttpOnly`, `SameSite=Strict`.
- A API verifica o JWT com o JWKS (EdDSA, emissor igual à origem de `NEON_AUTH_BASE_URL`). Qualquer falha devolve 401.
- A identidade é a claim `sub`. **Nunca vincula por e-mail** a uma conta local existente: e-mail igual devolve 409. Assim, quem cria uma conta no Neon Auth com o e-mail de outra pessoa não assume a conta dela.
- Conta com MFA ativo no Command AI continua exigindo o TOTP nessa rota.
- Com `REQUIRE_MFA` (padrão em produção), quem entra pelo Neon Auth sem MFA recebe uma **sessão limitada**: só configura o MFA do app e depois o painel abre. Assim o Neon Auth gerenciado, que não tem MFA, não vira uma porta sem segundo fator.
- O login local (senha e TOTP) continua existindo.

## Consequências

- Duas portas de entrada para manter. O MFA é do app (TOTP), não do Neon.
- O token do Neon não fica guardado no navegador.
- O JWT do Neon vem com `emailVerified`; hoje não é exigido porque a identidade é o `sub`. Se algum dia for usado para vincular contas, exigir `true`.

## Revisão

Reavaliar quando o Neon Auth oferecer MFA e passkeys, ou migrar para Better Auth próprio se o PRD continuar exigindo.
