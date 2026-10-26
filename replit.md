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
- Replit OIDC + PKCE in `lib/auth.js`; existing database sessions and `upsertUser`.

## Where things live

- The imported source, schema and original documentation are inside `artifacts/unbusyness`.
- `scripts/src/verify-unbusyness.mjs`: browser flow, permissions and mobile checks.
- `scripts/src/verify-unbusyness-auth.cjs`: isolated OIDC callback regression checks.
- Verification screenshots belong in ignored `generated-artifacts/`.

## Architecture decisions

- The generated template API must not claim `/api`; Unbusyness owns its own API and frontend.
- Do not port this app to the template Express/Drizzle/React architecture.

## Product

- Owner business management, manager dispatch and worker-only assigned jobs/tasks.
- Optional email/calendar, voice-provider, AI, SMS and payment connections.
- Without delivery credentials, outgoing messages are logged, not actually sent.

## User preferences

- “Do NOT rewrite the architecture or swap libraries. Only fix what is broken, and tell me what you changed.”

## Gotchas

- Never print or commit secrets. Losing/replacing the encryption key requires reconnecting integrations.
- Real-account Replit consent cannot be completed by an unauthenticated screenshot browser.
- The app is not published until the user clicks Publish; do not invent a production URL.

## Pointers

- `artifacts/unbusyness/README.md` and `VOICE_INTEGRATION.md` contain the original setup instructions.
