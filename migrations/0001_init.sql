-- Studio A :: initial schema
-- All timestamps are UTC epoch SECONDS. All money is integer CENTS.
-- Wall-clock times (business hours) are minutes-from-midnight in the salon's
-- local timezone (settings key `timezone`).

-- ---------------------------------------------------------------- accounts --

CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL,
  email_normalized   TEXT NOT NULL UNIQUE,
  phone              TEXT,                      -- E.164, e.g. +18045551234
  first_name         TEXT NOT NULL,
  last_name          TEXT NOT NULL DEFAULT '',
  password_hash      TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'client'
                       CHECK (role IN ('client', 'staff', 'admin')),
  sms_opt_in         INTEGER NOT NULL DEFAULT 1,
  sms_opt_out_at     INTEGER,
  stripe_customer_id TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_users_phone ON users (phone);
CREATE INDEX idx_users_role  ON users (role);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                  -- sha256(token); the raw token never lands in the DB
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user    ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- ---------------------------------------------------------------- catalog ---

CREATE TABLE services (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'General',
  duration_min  INTEGER NOT NULL,
  price_cents   INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL DEFAULT 0,     -- charged at booking; 0 = no deposit
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_services_active ON services (active, sort_order);

CREATE TABLE staff (
  id           TEXT PRIMARY KEY,
  user_id      TEXT UNIQUE REFERENCES users (id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT 'Stylist',
  bio          TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- Which stylists perform which services. A stylist with no rows here is
-- treated as able to perform everything.
CREATE TABLE staff_services (
  staff_id   TEXT NOT NULL REFERENCES staff (id)    ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE staff_hours (
  id        TEXT PRIMARY KEY,
  staff_id  TEXT NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  weekday   INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  start_min INTEGER NOT NULL,
  end_min   INTEGER NOT NULL,
  CHECK (end_min > start_min)
);
CREATE INDEX idx_staff_hours_staff ON staff_hours (staff_id, weekday);

CREATE TABLE time_off (
  id        TEXT PRIMARY KEY,
  staff_id  TEXT NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  starts_at INTEGER NOT NULL,
  ends_at   INTEGER NOT NULL,
  reason    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_time_off_staff ON time_off (staff_id, starts_at);

-- ----------------------------------------------------------- appointments ---

CREATE TABLE appointments (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  staff_id       TEXT REFERENCES staff (id) ON DELETE SET NULL,
  starts_at      INTEGER NOT NULL,
  ends_at        INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'booked'
                   CHECK (status IN ('booked', 'confirmed', 'completed', 'cancelled', 'no_show')),
  client_request TEXT NOT NULL DEFAULT '',      -- what the client typed when booking
  total_cents    INTEGER NOT NULL DEFAULT 0,    -- sum of appointment_services
  paid_cents     INTEGER NOT NULL DEFAULT 0,    -- sum of succeeded payments (incl. tips)
  cancelled_at   INTEGER,
  cancelled_by   TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_appt_starts ON appointments (starts_at);
CREATE INDEX idx_appt_client ON appointments (client_id, starts_at DESC);
CREATE INDEX idx_appt_staff  ON appointments (staff_id, starts_at);

-- Line items are snapshotted so historical appointments keep the price and
-- duration that were quoted, even after the service catalog changes.
CREATE TABLE appointment_services (
  id             TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  service_id     TEXT REFERENCES services (id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  duration_min   INTEGER NOT NULL,
  price_cents    INTEGER NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_appt_svc ON appointment_services (appointment_id, position);

-- ------------------------------------------------------------ client notes --

-- Staff-only. Never returned to a client account by any endpoint.
CREATE TABLE client_notes (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  author_id      TEXT REFERENCES users (id) ON DELETE SET NULL,
  appointment_id TEXT REFERENCES appointments (id) ON DELETE SET NULL,
  category       TEXT NOT NULL DEFAULT 'general'
                   CHECK (category IN ('general', 'formula', 'allergy', 'preference')),
  body           TEXT NOT NULL,
  pinned         INTEGER NOT NULL DEFAULT 0,    -- pinned notes surface on every booking
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_notes_client ON client_notes (client_id, pinned DESC, created_at DESC);

-- --------------------------------------------------------------- payments ---

CREATE TABLE payments (
  id             TEXT PRIMARY KEY,
  appointment_id TEXT REFERENCES appointments (id) ON DELETE SET NULL,
  client_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount_cents   INTEGER NOT NULL,              -- excludes tip
  tip_cents      INTEGER NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'usd',
  kind           TEXT NOT NULL DEFAULT 'balance'
                   CHECK (kind IN ('deposit', 'balance', 'full')),
  method         TEXT NOT NULL DEFAULT 'card'
                   CHECK (method IN ('card', 'cash', 'other')),
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'cancelled')),
  provider       TEXT NOT NULL DEFAULT 'stripe',
  provider_ref   TEXT,                          -- Stripe PaymentIntent id
  failure_reason TEXT,
  recorded_by    TEXT REFERENCES users (id) ON DELETE SET NULL,  -- set for in-salon payments
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_payments_provider_ref
  ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX idx_payments_appt   ON payments (appointment_id);
CREATE INDEX idx_payments_client ON payments (client_id, created_at DESC);

-- --------------------------------------------------------------- messaging --

CREATE TABLE campaigns (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  body            TEXT NOT NULL,                -- supports {{first_name}} and {{salon_name}}
  audience        TEXT NOT NULL DEFAULT 'all'
                    CHECK (audience IN ('all', 'upcoming', 'lapsed', 'recent', 'custom')),
  audience_params TEXT NOT NULL DEFAULT '{}',   -- JSON, e.g. {"days":90} or {"user_ids":[...]}
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'sending', 'sent', 'cancelled')),
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count      INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER
);
CREATE INDEX idx_campaigns_created ON campaigns (created_at DESC);

-- One row per text message, outbound or inbound. Campaign sends are written
-- here as `queued` and drained by the cron handler so a 400-client blast never
-- has to finish inside one request.
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL
                   CHECK (kind IN ('campaign', 'reminder', 'transactional', 'inbound')),
  campaign_id    TEXT REFERENCES campaigns (id) ON DELETE CASCADE,
  appointment_id TEXT REFERENCES appointments (id) ON DELETE CASCADE,
  user_id        TEXT REFERENCES users (id) ON DELETE SET NULL,
  to_phone       TEXT NOT NULL,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'sent', 'failed', 'skipped', 'received')),
  provider       TEXT NOT NULL DEFAULT 'twilio',
  provider_ref   TEXT,
  error          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  -- Guards against duplicate sends: reminders use `<appointment_id>:<offset>h`.
  dedupe_key     TEXT,
  created_at     INTEGER NOT NULL,
  sent_at        INTEGER
);
CREATE UNIQUE INDEX idx_messages_dedupe  ON messages (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_messages_queued  ON messages (status, created_at);
CREATE INDEX idx_messages_user    ON messages (user_id, created_at DESC);
CREATE INDEX idx_messages_created ON messages (created_at DESC);

-- --------------------------------------------------------------- settings ---

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
