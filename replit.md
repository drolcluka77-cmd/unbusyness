# Unbusyness

Imported trade-business MVP: calls → quotes → jobs → invoices → payments.

## Run & Operate

- Managed workflow: `artifacts/unbusyness: web`, port 3000.
- App directory: `artifacts/unbusyness`; start with `node server.js`. No build step.
- Required: managed `DATABASE_URL`; `ENCRYPTION_KEY` for mailbox/calendar credentials.
- `DEV_LOGIN=1` is development-only and hard-disabled when `NODE_ENV=production`.
- Development startup applies `lib/schema.sql`. Publish manages the production schema.
- Always-on Reserved VM target: reminders run every 15 minutes.

## Stack

- Original Node HTTP router, CommonJS, PostgreSQL with `pg`, plain HTML/CSS/JavaScript.
- Original IMAPFlow, Mailparser and Nodemailer integrations.
- Native Unbusyness email/password accounts and optional Google/Microsoft login.
- Preserve the existing database sessions and `upsertUser`; developer Replit OIDC + PKCE remains available.

## Where things live

- The imported source, schema and original documentation are inside `artifacts/unbusyness`.
- `scripts/src/verify-unbusyness.mjs`: browser flow, permissions and mobile checks.
- `scripts/src/verify-unbusyness-auth.cjs`: isolated OIDC callback regression checks.
- `scripts/src/verify-unbusyness-accounts.mjs`: native-account browser checks, using a temporary test server and QA data in the development database.
- Verification screenshots belong in ignored `generated-artifacts/`.

## Architecture decisions

- The generated template API must not claim `/api`; Unbusyness owns its own API and frontend.
- Do not port this app to the template Express/Drizzle/React architecture.
- Unbusyness users must not need a Replit account. Login OAuth requests identity scopes only; mailbox/calendar authorization stays separate.
- System confirmation/reset emails use SMTP. Customer email uses the company's connected mailbox or is saved to Outbox; no app-wide email fallback.

## Product

- Owner business management, manager dispatch and worker-only assigned jobs/tasks.
- Optional email/calendar, voice-provider, AI, SMS and payment connections.
- Without delivery credentials, outgoing messages are logged, not actually sent.

## User preferences

- “Do NOT rewrite the architecture or swap libraries. Only fix what is broken, and tell me what you changed.”
- Apply supplied patches over current code and retain all existing fixes, even when the patch was written against an older version.

## Gotchas

- Never print or commit secrets. Losing/replacing the encryption key requires reconnecting integrations.
- Real-account Replit consent cannot be completed by an unauthenticated screenshot browser.
- The app is not published until the user clicks Publish; do not invent a production URL.
- Configure system SMTP before publishing native accounts; confirmation/reset links are logged only in development when SMTP is absent.

## Pointers

- `artifacts/unbusyness/README.md` and `VOICE_INTEGRATION.md` contain the original setup instructions.
