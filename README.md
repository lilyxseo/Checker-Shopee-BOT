# Checker-Shopee-BOT

Telegram private-chat bot using Supabase PostgreSQL and a TypeScript/Deno Edge Function.

## Status

Database and webhook implementation added. **Not production ready:** the authorized cekapi.com API contract has not been supplied, so the provider adapter intentionally returns a controlled failure and refunds the reservation. No real lookup is performed. Supply official endpoint, authentication, request/response examples, error semantics, and provider idempotency guarantees before implementing `providerCheck`.

## Configuration

Copy `.env.example` to an ignored local secret file. Never commit tokens. Set Supabase URL/service role key, Telegram token, a random webhook secret (Telegram permits 1–256 characters from A–Z, a–z, 0–9, `_`, `-`), and comma-separated numeric Telegram admin IDs. Reserved `CEKAPI_*` variables are currently unused. Telegram JWT verification is disabled only because the function verifies Telegram's secret header before reading updates. Keep the service role key restricted to the Edge Function.

## Database and tests

Use a disposable local Supabase instance:

```sh
supabase start
supabase db reset
deno check supabase/functions/telegram-webhook/index.ts
deno test --allow-read tests/core.test.ts
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f supabase/tests/bot.sql
python3 tests/concurrency.py
```

Parser/security tests can also run with Node 24: `node --test tests/core.test.ts`. SQL tests cover registration, WIB date reset, free/paid usage, insufficient credits, duplicate updates, repeated approvals/refunds, rejection, and consent authorization. SQL tests roll back all changes. CI runs type checks and database tests; no deployment job is configured. The concurrency test uses separate PostgreSQL sessions for duplicate debits and simultaneous approvals; it must also pass before production approval.

## Commands

Users: `/start`, `/saldo`, `/stats`, `/history`, `/topup 100`, `/cek 6281234567890`.

Admins: `/admin`, `/pending`, `/approve ID`, `/reject ID`, `/grant USER_ID PHONE EVIDENCE_REF`, `/revoke USER_ID PHONE`.

Topups cost Rp50 per credit. Admins must independently verify payment before approving; requests alone are not proof of payment. Pending requests show their amount and user ID. Users can inspect credits and ledger after approval.

Owner consent must be verified outside the bot through an authorized process. An admin records an opaque evidence reference with `/grant`; it expires after 24 hours and can be revoked. This implementation does not provide OTP ownership verification. Do not put private evidence documents into Telegram commands. There is no bulk-check command. Only exact consented numbers can reach the adapter.

## Transaction behavior

The service-role-only RPC locks the user, records the unique Telegram update, resets the quota lazily by `Asia/Jakarta` date, and reserves one of three free checks or one credit in one transaction. No cron is needed for the visible 00:00 WIB reset. Topup approval locks its recipient and request, writes an audit ledger entry, and credits exactly once. RLS blocks client access; `p_admin` is trusted only because callers must possess the server-side service role key.

The rate limit is one accepted command per user per two seconds, persisted in PostgreSQL across instances. Duplicates never call the provider again. Deadlocks or transient database failures roll back and return HTTP 503 for Telegram retry.

Provider calls must have a timeout and must not retry ambiguous outcomes. Future adapter transport/timeouts must return `unknown`, leaving a charge for manual reconciliation. Only a definitive no-service failure may refund. A process crash after reservation leaves a pending check; admins see its count. Reconcile pending/unknown checks against provider records before calling `bot_finish` using an authorized backend. Do not automatically retry stale reservations.

Telegram sends occur after the transaction. If delivery fails, the webhook returns 503 but a duplicate retry is ignored, so the reply can be lost. Balances/ledger remain correct; users can query `/stats` or `/history`. A durable outbox is needed for guaranteed reply delivery. Phone numbers are stored only in checks and consent records: define a retention/deletion schedule before production.

## Release gate

Do not deploy or register a production webhook until Deno checks, PostgreSQL integration tests, concurrent-session tests, and the authorized provider adapter tests succeed. Configure Telegram `setWebhook` with the same `secret_token` and `allowed_updates=["message"]` only after that gate. No production deployment has been performed.
