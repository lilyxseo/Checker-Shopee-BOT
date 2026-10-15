# Checker-Shopee-BOT

Telegram private-chat bot using Supabase PostgreSQL and a TypeScript/Deno Edge Function.

## Status

Database, webhook, and a cekapi.com ShopeePay adapter are implemented. The adapter uses the user-supplied GET `/cekewallet?customer_no=08...&ewallet=spay&apikey=...` contract and recognizes only `data.status="ditemukan"`, `data.product="spay"`, and a nonempty string `data.username`. It stays disabled until `CEKAPI_ENABLED=true` and `CEKAPI_API_KEY` are configured. No live provider request was made during development. Other provider status/error semantics remain undocumented and are treated as unknown for manual reconciliation.

## Configuration

Copy `.env.example` to an ignored local secret file. Never commit tokens. Set Supabase URL/service role key, Telegram token, a random webhook secret (Telegram permits 1–256 characters from A–Z, a–z, 0–9, `_`, `-`), and comma-separated numeric Telegram admin IDs. Set `CEKAPI_API_KEY` as a Supabase secret and optionally set `CEKAPI_BASE_URL=https://v1.cekapi.com`. Leave `CEKAPI_ENABLED=false` until tests pass and the updated function is installed; setting it to `true` permits authorized lookups. The base URL is restricted to the documented HTTPS host and path to prevent leaking query-string API keys. Requests have an 8-second timeout, reject redirects, cap responses at 32 KiB, and never retry. The adapter does not log URLs, keys, responses, or phone numbers. The undocumented `sisa_saldo` field is not shown as a wallet balance. Telegram JWT verification is disabled only because the function verifies Telegram's secret header before reading updates. Keep the service role key restricted to the Edge Function.

## Database and tests

Use a disposable local Supabase instance:

```sh
supabase start
supabase db reset
deno check supabase/functions/telegram-webhook/index.ts
deno test --allow-read tests/core.test.ts tests/provider.test.ts
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f supabase/tests/bot.sql
python3 tests/concurrency.py
```

Parser/security and adapter tests can also run with Node 24: `node --test tests/core.test.ts tests/provider.test.ts`. Adapter tests use mocks only, with no API key or live lookup. SQL tests cover registration, WIB date reset, free/paid usage, insufficient credits, duplicate updates, repeated approvals/refunds, rejection, and consent authorization. SQL tests roll back all changes. CI runs Deno type checks and database tests against disposable PostgreSQL 17 with Supabase API roles; no deployment job is configured. The concurrency test uses separate PostgreSQL sessions for duplicate debits and simultaneous approvals; it must also pass before production approval.

## Commands

Users: `/start`, `/saldo`, `/stats`, `/history`, `/topup 100`, `/cek 6281234567890`.

Admins: `/admin`, `/user USER_ID`, `/pending`, `/approve ID`, `/reject ID`, `/grant USER_ID PHONE EVIDENCE_REF`, `/revoke USER_ID PHONE`.

Topups cost Rp50 per credit. Admins must independently verify payment before approving; requests alone are not proof of payment. Pending requests show their amount and user ID. Users can inspect credits and ledger after approval.

Owner consent must be verified outside the bot through an authorized process. An admin records an opaque evidence reference with `/grant`; it expires after 24 hours and can be revoked. This implementation does not provide OTP ownership verification. Do not put private evidence documents into Telegram commands. There is no bulk-check command. Only exact consented numbers can reach the adapter.

## Transaction behavior

The service-role-only RPC locks the user, records the unique Telegram update, resets the quota lazily by `Asia/Jakarta` date, and reserves one of three free checks or one credit in one transaction. No cron is needed for the visible 00:00 WIB reset. Topup approval locks its recipient and request, writes an audit ledger entry, and credits exactly once. RLS blocks client access; `p_admin` is trusted only because callers must possess the server-side service role key.

The rate limit is one accepted command per user per two seconds, persisted in PostgreSQL across instances. Duplicates never call the provider again. Deadlocks or transient database failures roll back and return HTTP 503 for Telegram retry.

Provider calls must have a timeout and must not retry ambiguous outcomes. Adapter transport/timeouts, non-2xx responses, invalid responses, and undocumented statuses return `unknown`, leaving a charge for manual reconciliation. Missing/disabled/invalid local configuration makes no provider request and refunds the reservation. Only a definitive no-service failure may refund. A process crash after reservation leaves a pending check; admins see its count. Reconcile pending/unknown checks against provider records before calling `bot_finish` using an authorized backend. Do not automatically retry stale reservations.

Telegram sends occur after the transaction. If delivery fails, the webhook returns 503 but a duplicate retry is ignored, so the reply can be lost. Balances/ledger remain correct; users can query `/stats` or `/history`. A durable outbox is needed for guaranteed reply delivery. Phone numbers are stored only in checks and consent records: define a retention/deletion schedule before production.

## Release gate

Do not deploy or register a production webhook until Deno checks, PostgreSQL integration tests, concurrent-session tests, and the authorized provider adapter tests succeed. For an existing Dashboard deployment, update `index.ts`, keep `core.ts`, and add `provider.ts` in the same function; `index.ts` imports the new file. Keep Verify JWT off and the Telegram webhook secret unchanged. Set `CEKAPI_ENABLED=true` only when ready to use real authorized checks; no database migration is needed for this adapter update. Configure Telegram `setWebhook` with the same `secret_token` and `allowed_updates=["message"]` only after that gate. No production deployment has been performed.
