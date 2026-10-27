-- Unbusyness schema. Runs on every start; every statement is safe to repeat.

CREATE TABLE IF NOT EXISTS businesses (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  trade           TEXT DEFAULT 'Plumbing',
  address         TEXT DEFAULT '',
  phone           TEXT DEFAULT '',
  email           TEXT DEFAULT '',
  website         TEXT DEFAULT '',
  tax_id          TEXT DEFAULT '',
  tax_rate        NUMERIC(6,3) NOT NULL DEFAULT 0,
  tax_label       TEXT NOT NULL DEFAULT 'Sales tax',
  currency        TEXT NOT NULL DEFAULT 'USD',
  timezone        TEXT NOT NULL DEFAULT 'America/Chicago',
  payment_terms   INT NOT NULL DEFAULT 14,
  quote_valid_days INT NOT NULL DEFAULT 14,
  payment_notes   TEXT DEFAULT '',
  logo_mime       TEXT,
  logo_data       BYTEA,
  next_invoice_no INT NOT NULL DEFAULT 1,
  next_quote_no   INT NOT NULL DEFAULT 1,
  voice_key       TEXT UNIQUE NOT NULL,
  voice_secret    TEXT NOT NULL,
  stripe_account  TEXT,
  stripe_ready    BOOLEAN NOT NULL DEFAULT FALSE,
  plan            TEXT NOT NULL DEFAULT 'team',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
  auth_sub    TEXT UNIQUE NOT NULL,
  email       TEXT DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'owner',
  phone       TEXT DEFAULT '',
  trade_role  TEXT DEFAULT '',
  color       TEXT DEFAULT '#1F4D45',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE CASCADE,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  token       TEXT PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'worker',
  name        TEXT DEFAULT '',
  trade_role  TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS customers (
  id          SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '',
  phone       TEXT DEFAULT '',
  email       TEXT DEFAULT '',
  address     TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_biz ON customers(business_id);

CREATE TABLE IF NOT EXISTS services (
  id          SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  unit        TEXT NOT NULL DEFAULT 'job',
  price       NUMERIC(12,2) NOT NULL DEFAULT 0,
  keywords    TEXT DEFAULT '',
  position    INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS calls (
  id             SERIAL PRIMARY KEY,
  business_id    INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id    INT REFERENCES customers(id) ON DELETE SET NULL,
  external_id    TEXT,
  from_phone     TEXT DEFAULT '',
  customer_name  TEXT DEFAULT '',
  customer_email TEXT DEFAULT '',
  address        TEXT DEFAULT '',
  intent         TEXT DEFAULT 'new_job',
  service        TEXT DEFAULT '',
  urgency        TEXT DEFAULT 'normal',
  preferred_time TEXT DEFAULT '',
  summary        TEXT DEFAULT '',
  transcript     TEXT DEFAULT '',
  recording_url  TEXT DEFAULT '',
  duration_sec   INT,
  status         TEXT NOT NULL DEFAULT 'new',
  raw            JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calls_ext ON calls(business_id, external_id);

CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
  call_id     INT REFERENCES calls(id) ON DELETE SET NULL,
  due_at      TIMESTAMPTZ,
  done_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quotes (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id  INT REFERENCES customers(id) ON DELETE SET NULL,
  call_id      INT REFERENCES calls(id) ON DELETE SET NULL,
  number       TEXT NOT NULL,
  title        TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'draft',
  notes        TEXT DEFAULT '',
  tax_rate     NUMERIC(6,3) NOT NULL DEFAULT 0,
  subtotal     NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax          NUMERIC(12,2) NOT NULL DEFAULT 0,
  total        NUMERIC(12,2) NOT NULL DEFAULT 0,
  valid_until  DATE,
  public_token TEXT UNIQUE NOT NULL,
  ai_drafted   BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at      TIMESTAMPTZ,
  viewed_at    TIMESTAMPTZ,
  accepted_at  TIMESTAMPTZ,
  followup_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id               SERIAL PRIMARY KEY,
  business_id      INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id      INT REFERENCES customers(id) ON DELETE SET NULL,
  quote_id         INT REFERENCES quotes(id) ON DELETE SET NULL,
  call_id          INT REFERENCES calls(id) ON DELETE SET NULL,
  title            TEXT NOT NULL DEFAULT '',
  address          TEXT DEFAULT '',
  scheduled_at     TIMESTAMPTZ,
  duration_min     INT NOT NULL DEFAULT 90,
  assigned_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'scheduled',
  price            NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes            TEXT DEFAULT '',
  on_way_at        TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_biz_time ON jobs(business_id, scheduled_at);

CREATE TABLE IF NOT EXISTS photos (
  id          SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  job_id      INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT 'job',
  mime        TEXT NOT NULL DEFAULT 'image/jpeg',
  data        BYTEA NOT NULL,
  uploaded_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id             SERIAL PRIMARY KEY,
  business_id    INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id    INT REFERENCES customers(id) ON DELETE SET NULL,
  job_id         INT REFERENCES jobs(id) ON DELETE SET NULL,
  quote_id       INT REFERENCES quotes(id) ON DELETE SET NULL,
  number         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft',
  notes          TEXT DEFAULT '',
  tax_rate       NUMERIC(6,3) NOT NULL DEFAULT 0,
  subtotal       NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax            NUMERIC(12,2) NOT NULL DEFAULT 0,
  total          NUMERIC(12,2) NOT NULL DEFAULT 0,
  issue_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date       DATE,
  public_token   TEXT UNIQUE NOT NULL,
  sent_at        TIMESTAMPTZ,
  viewed_at      TIMESTAMPTZ,
  paid_at        TIMESTAMPTZ,
  paid_method    TEXT,
  reminders_sent INT NOT NULL DEFAULT 0,
  last_reminder  TIMESTAMPTZ,
  stripe_session TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS line_items (
  id          SERIAL PRIMARY KEY,
  doc_type    TEXT NOT NULL,
  doc_id      INT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  qty         NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit        TEXT NOT NULL DEFAULT 'job',
  unit_price  NUMERIC(12,2) NOT NULL DEFAULT 0,
  position    INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS line_items_doc ON line_items(doc_type, doc_id);

CREATE TABLE IF NOT EXISTS outbox (
  id          SERIAL PRIMARY KEY,
  business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL DEFAULT 'email',
  to_addr     TEXT NOT NULL DEFAULT '',
  subject     TEXT DEFAULT '',
  body        TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'logged',
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity (
  id          SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  ref_type    TEXT,
  ref_id      INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_biz ON activity(business_id, created_at DESC);

-- Voice integration layer (provider-agnostic)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS voice_provider TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS voice_provider_secret TEXT DEFAULT '';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS work_days TEXT NOT NULL DEFAULT '1,2,3,4,5';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS work_start INT NOT NULL DEFAULT 8;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS work_end INT NOT NULL DEFAULT 17;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS slot_minutes INT NOT NULL DEFAULT 120;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS service_area TEXT DEFAULT '';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS emergency_policy TEXT DEFAULT 'For leaks, flooding, no heat or no power, we call back within 15 minutes.';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tentative BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS voice_call_id TEXT;

CREATE TABLE IF NOT EXISTS voice_events (
  id          SERIAL PRIMARY KEY,
  business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT DEFAULT '',
  external_id TEXT,
  status      TEXT NOT NULL,
  error       TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_events_biz ON voice_events(business_id, created_at DESC);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'generic';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS to_phone TEXT DEFAULT '';

-- Companies, users and memberships (company-based roles)
-- "businesses" is the Company table. Users are global identities; memberships link them to companies.
CREATE TABLE IF NOT EXISTS memberships (
  id          SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'worker',
  trade_role  TEXT DEFAULT '',
  color       TEXT DEFAULT '#1F4D45',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);
INSERT INTO memberships(business_id, user_id, role, trade_role, color, active)
  SELECT business_id, id, role, COALESCE(trade_role,''), COALESCE(color,'#1F4D45'), active FROM users WHERE business_id IS NOT NULL
  ON CONFLICT (business_id, user_id) DO NOTHING;
CREATE TABLE IF NOT EXISTS company_roles (
  id          SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (business_id, key)
);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_user_id INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id) ON DELETE SET NULL;

-- Time-based commitments (synced to external calendars). Tasks are never synced.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'job';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cal_event_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cal_provider TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cal_synced_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cal_error TEXT;

-- Email + calendar connections. Credentials are encrypted (AES-256-GCM) and never leave the server.
CREATE TABLE IF NOT EXISTS integrations (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  account      TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'connected',
  credentials  TEXT,
  settings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  connected_by INT REFERENCES users(id) ON DELETE SET NULL,
  last_ok_at   TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, kind)
);

-- Own Unbusyness accounts (email + password, Google, Microsoft). No Replit account needed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_email_lower ON users(lower(email));
CREATE TABLE IF NOT EXISTS user_identities (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  email       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  token_hash  TEXT UNIQUE NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Team invites are bound to the invited person's email address (lib/invites.js).
-- Older invites keep an empty address and still work, but can never change an existing membership.
ALTER TABLE invites ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';

-- Unbusyness team console (lib/admin.js): every change made there is recorded here.
CREATE TABLE IF NOT EXISTS admin_audit (
  id             SERIAL PRIMARY KEY,
  admin_user_id  INT REFERENCES users(id) ON DELETE SET NULL,
  admin_email    TEXT NOT NULL DEFAULT '',
  action         TEXT NOT NULL,
  business_id    INT REFERENCES businesses(id) ON DELETE SET NULL,
  target_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_time ON admin_audit(created_at DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
