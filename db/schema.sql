-- =====================================================================
-- Amazing Salon — Gift Card POS
-- db/schema.sql  (idempotent: safe to run repeatedly)
--
-- Order: extensions → enums → tables → indexes → views →
--        functions/triggers → reference seed → demo seed
--
-- Money: NUMERIC(12,2) at rest. Every function that moves money takes
-- BIGINT cents and converts exactly (no floats anywhere).
--
-- The ONLY write path for gift_cards.balance / gift_cards.status is the
-- fn_* functions below (enforced by trg_gift_cards_guard).
--
-- MULTI-TENANT: every salon is a row in `businesses`. Each salon-owned
-- table has business_id and a FORCE'd row-level-security policy, so the
-- app (connected as the non-superuser table owner) only ever sees rows of
-- the salon named by `SET app.business_id = '<id>'`. With no salon set,
-- every tenant table looks empty. Never connect the API as a superuser:
-- superusers bypass RLS.
--
-- To skip the demo users/terminals/cards (production install):
--     SET gc.skip_demo_seed = 'on';   -- before running this file
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. EXTENSIONS
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- crypt()/gen_salt() for PIN hashes, digest()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy search on card number / holder

-- ---------------------------------------------------------------------
-- 2. ENUM TYPES
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE card_status AS ENUM (
    'PENDING_ACTIVATION','ACTIVE','PARTIALUSED','CLOSED',
    'FROZEN','EXPIRED','VOIDED','LOST_REPLACED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE txn_type AS ENUM (
    'ISSUE','ACTIVATE','RELOAD','REDEEM','REFUND_TO_CARD','TIP_FROM_CARD',
    'ADJUSTMENT','TRANSFER_OUT','TRANSFER_IN','MERGE_OUT','MERGE_IN',
    'VOID','EXPIRE','REPLACE_OUT','REPLACE_IN','REVERSAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE actor_type AS ENUM ('USER','KIOSK','GATEWAY','SYSTEM','IMPORT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE role_name AS ENUM ('OWNER','MANAGER','STAFF','KIOSK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE channel AS ENUM ('POS','KIOSK','ONLINE','IMPORT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE currency_code AS ENUM ('USD','CAD','EUR','GBP','AUD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE msg_channel AS ENUM ('EMAIL','SMS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- 2b. TENANTS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS businesses (
  id           BIGSERIAL PRIMARY KEY,
  slug         VARCHAR(40)  NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name         VARCHAR(80)  NOT NULL,
  status       VARCHAR(12)  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  owner_email  VARCHAR(120),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- CID: the salon's account number 00001–99999 (shown zero-padded), in sign-up
-- order, never reused. Existing salons are numbered oldest first.
CREATE SEQUENCE IF NOT EXISTS business_cid_seq MINVALUE 1 MAXVALUE 99999 NO CYCLE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cid INT;
ALTER TABLE businesses ALTER COLUMN cid SET DEFAULT nextval('business_cid_seq');
ALTER SEQUENCE business_cid_seq OWNED BY businesses.cid;
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM businesses WHERE cid IS NULL ORDER BY created_at, id LOOP
    UPDATE businesses SET cid = nextval('business_cid_seq') WHERE id = r.id;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'businesses_cid_key') THEN
    ALTER TABLE businesses ADD CONSTRAINT businesses_cid_key UNIQUE (cid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'businesses_cid_range') THEN
    ALTER TABLE businesses ADD CONSTRAINT businesses_cid_range CHECK (cid BETWEEN 1 AND 99999);
  END IF;
END $$;
ALTER TABLE businesses ALTER COLUMN cid SET NOT NULL;

-- The salon this connection is acting for (NULL = none → tenant tables look empty).
CREATE OR REPLACE FUNCTION fn_current_business() RETURNS BIGINT
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.business_id', true), '')::BIGINT $$;

-- Platform-level access (signup, terminal-key lookup, platform admin). Set
-- only by explicit system code paths in the API, never per salon request.
CREATE OR REPLACE FUNCTION fn_system_mode() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.system', true), '') = 'on' $$;

-- One-time upgrade of a pre-multi-tenant database: everything that exists
-- becomes business #1. Old global unique keys are dropped here; the
-- per-salon replacements are (re)created idempotently in section 4b.
DO $$
DECLARE v_name TEXT; v_slug TEXT; t TEXT;
BEGIN
  IF to_regclass('public.users') IS NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'business_id') THEN
    RETURN;
  END IF;
  RAISE NOTICE 'Upgrading single-salon database to multi-tenant (existing data → business 1)';

  SELECT value->>'business_name' INTO v_name FROM settings WHERE key = 'general';
  v_name := COALESCE(NULLIF(trim(v_name), ''), 'My Salon');
  v_slug := trim(BOTH '-' FROM regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  IF v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' THEN v_slug := 'salon-1'; END IF;
  INSERT INTO businesses (id, slug, name) VALUES (1, left(v_slug, 40), left(v_name, 80));
  PERFORM setval('businesses_id_seq', 1);

  FOREACH t IN ARRAY ARRAY['users','role_permissions','terminals','customers','gift_cards',
      'gift_card_transactions','audit_log','card_tags','gift_card_tags','message_templates',
      'message_log','settings','import_jobs','backups','idempotency_keys'] LOOP
    -- DEFAULT 1 fills existing rows without UPDATE (append-only triggers stay quiet).
    EXECUTE format('ALTER TABLE %I ADD COLUMN business_id BIGINT NOT NULL DEFAULT 1 REFERENCES businesses(id)', t);
  END LOOP;

  ALTER TABLE users                  DROP CONSTRAINT IF EXISTS users_username_key;
  ALTER TABLE role_permissions       DROP CONSTRAINT IF EXISTS role_permissions_pkey;
  ALTER TABLE terminals              DROP CONSTRAINT IF EXISTS terminals_code_key;
  ALTER TABLE customers              DROP CONSTRAINT IF EXISTS customers_phone_key;
  ALTER TABLE gift_cards             DROP CONSTRAINT IF EXISTS gift_cards_card_number_key;
  ALTER TABLE gift_card_transactions DROP CONSTRAINT IF EXISTS gift_card_transactions_idempotency_key_key;
  ALTER TABLE card_tags              DROP CONSTRAINT IF EXISTS card_tags_name_key;
  ALTER TABLE message_templates      DROP CONSTRAINT IF EXISTS message_templates_key_channel_key;
  ALTER TABLE settings               DROP CONSTRAINT IF EXISTS settings_pkey;
  ALTER TABLE idempotency_keys       DROP CONSTRAINT IF EXISTS idempotency_keys_pkey;
END $$;

-- ---------------------------------------------------------------------
-- 3. TABLES   (per-salon unique keys live in section 4b)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  BIGSERIAL PRIMARY KEY,
  business_id         BIGINT       NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  name                VARCHAR(80)  NOT NULL,
  username            VARCHAR(40)  NOT NULL,
  pin_hash            TEXT,
  password_hash       TEXT,
  role                role_name    NOT NULL DEFAULT 'STAFF',
  active              BOOLEAN      NOT NULL DEFAULT TRUE,
  failed_pin_attempts INT          NOT NULL DEFAULT 0 CHECK (failed_pin_attempts >= 0),
  locked_until        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_login_at       TIMESTAMPTZ,
  CONSTRAINT users_has_credential CHECK (pin_hash IS NOT NULL OR password_hash IS NOT NULL)
);

-- Table-driven RBAC: adding a role = ALTER TYPE role_name ADD VALUE + rows here.
CREATE TABLE IF NOT EXISTS role_permissions (
  business_id BIGINT      NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  role        role_name   NOT NULL,
  permission  VARCHAR(40) NOT NULL
);

CREATE TABLE IF NOT EXISTS terminals (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT       NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  code          VARCHAR(40)  NOT NULL,                 -- e.g. FRONT-DESK-1
  name          VARCHAR(80)  NOT NULL,
  kind          VARCHAR(10)  NOT NULL DEFAULT 'POS' CHECK (kind IN ('POS','KIOSK')),
  api_key_hash  TEXT         NOT NULL,                 -- sha256 hex of the key
  last_seen_at  TIMESTAMPTZ,
  active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id               BIGSERIAL PRIMARY KEY,
  business_id      BIGINT      NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  first_name       VARCHAR(60),
  last_name        VARCHAR(60),
  phone            VARCHAR(20),                        -- unique per salon; NULLs allowed
  email            VARCHAR(120),
  marketing_opt_in BOOLEAN     NOT NULL DEFAULT FALSE,
  loyalty_points   INT         NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  erased_at        TIMESTAMPTZ,                        -- right-to-be-forgotten marker
  CONSTRAINT customers_erased_is_blank CHECK (
    erased_at IS NULL OR (first_name IS NULL AND last_name IS NULL AND phone IS NULL AND email IS NULL))
);

CREATE SEQUENCE IF NOT EXISTS gift_card_number_seq START 3460011;

CREATE TABLE IF NOT EXISTS gift_cards (
  id                    BIGSERIAL PRIMARY KEY,
  business_id           BIGINT        NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  card_number           VARCHAR(20)   NOT NULL CHECK (card_number ~ '^[0-9A-Z-]{4,20}$'),
  pan_token             TEXT,                          -- tokenized swipe data, never raw PAN
  pin_hash              TEXT,                          -- optional card PIN (bcrypt)
  status                card_status   NOT NULL DEFAULT 'PENDING_ACTIVATION',
  face_value            NUMERIC(12,2) NOT NULL CHECK (face_value >= 0),
  balance               NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  currency              currency_code NOT NULL DEFAULT 'USD',
  label                 VARCHAR(60),
  color_tag             VARCHAR(20),
  customer_id           BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  issued_by             BIGINT REFERENCES users(id),
  issued_terminal       BIGINT REFERENCES terminals(id),
  issue_channel         channel       NOT NULL DEFAULT 'POS',
  activation_date       TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,
  last_used_at          TIMESTAMPTZ,
  frozen_at             TIMESTAMPTZ,
  frozen_by             BIGINT REFERENCES users(id),
  freeze_reason         TEXT,
  voided_at             TIMESTAMPTZ,
  voided_by             BIGINT REFERENCES users(id),
  void_reason           TEXT,
  replaced_by_card_id   BIGINT REFERENCES gift_cards(id),
  notes                 TEXT,
  kiosk_failed_attempts INT           NOT NULL DEFAULT 0,
  kiosk_locked_until    TIMESTAMPTZ,
  archived_at           TIMESTAMPTZ,                   -- Clear Zero-Balance (30-day undo)
  archived_by           BIGINT REFERENCES users(id),
  deleted_at            TIMESTAMPTZ,                   -- soft delete
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT gc_frozen_consistent  CHECK ((status = 'FROZEN') = (frozen_at IS NOT NULL)),
  CONSTRAINT gc_voided_consistent  CHECK (status <> 'VOIDED' OR voided_at IS NOT NULL),
  CONSTRAINT gc_terminal_zero      CHECK (status NOT IN ('VOIDED','EXPIRED','LOST_REPLACED','CLOSED') OR balance = 0),
  CONSTRAINT gc_live_has_balance   CHECK (status NOT IN ('ACTIVE','PARTIALUSED') OR balance > 0),
  CONSTRAINT gc_no_self_replace    CHECK (replaced_by_card_id IS NULL OR replaced_by_card_id <> id)
);

-- Append-only money ledger.
CREATE TABLE IF NOT EXISTS gift_card_transactions (
  id               BIGSERIAL PRIMARY KEY,
  business_id      BIGINT        NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  card_id          BIGINT        NOT NULL REFERENCES gift_cards(id),
  txn_type         txn_type      NOT NULL,
  amount           NUMERIC(12,2) NOT NULL,             -- signed: +credit / -debit
  balance_after    NUMERIC(12,2) NOT NULL CHECK (balance_after >= 0),
  memo             TEXT,
  external_ref     VARCHAR(80),                        -- ticket / receipt / gateway id
  related_card_id  BIGINT REFERENCES gift_cards(id),   -- counter-party for transfer/merge/replace
  reverses_txn_id  BIGINT UNIQUE REFERENCES gift_card_transactions(id),
  actor_type       actor_type    NOT NULL DEFAULT 'USER',
  actor_id         BIGINT REFERENCES users(id),
  approved_by      BIGINT REFERENCES users(id),
  terminal_id      BIGINT REFERENCES terminals(id),
  ip               INET,
  user_agent       TEXT,
  idempotency_key  VARCHAR(80),                        -- unique per salon; client key (<=64) + ':out'/':in' suffixes
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Append-only non-money events.
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT       NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  actor_type   actor_type   NOT NULL DEFAULT 'USER',
  actor_id     BIGINT REFERENCES users(id),
  terminal_id  BIGINT REFERENCES terminals(id),
  entity_type  VARCHAR(40)  NOT NULL,
  entity_id    TEXT,
  card_id      BIGINT REFERENCES gift_cards(id),
  action       VARCHAR(60)  NOT NULL,
  payload      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ip           INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS card_tags (
  id     BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  name   VARCHAR(40) NOT NULL,
  color  VARCHAR(20) NOT NULL DEFAULT 'slate'
);

CREATE TABLE IF NOT EXISTS gift_card_tags (
  business_id BIGINT NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  card_id BIGINT NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  tag_id  BIGINT NOT NULL REFERENCES card_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, tag_id)
);

CREATE TABLE IF NOT EXISTS message_templates (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT       NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  key         VARCHAR(40)  NOT NULL,                   -- card_delivered, low_balance, ...
  channel     msg_channel  NOT NULL,
  subject     VARCHAR(160),
  body        TEXT         NOT NULL,
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_log (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT      NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  template_key  VARCHAR(40),
  card_id       BIGINT REFERENCES gift_cards(id),
  customer_id   BIGINT REFERENCES customers(id),
  channel       msg_channel NOT NULL,
  recipient     TEXT,                                  -- blanked on GDPR erase
  status        VARCHAR(12) NOT NULL CHECK (status IN ('QUEUED','SENT','FAILED','SIMULATED')),
  error         TEXT,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  business_id BIGINT      NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  key         TEXT        NOT NULL,
  value       JSONB       NOT NULL,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT      NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  filename     TEXT        NOT NULL,
  dry_run      BOOLEAN     NOT NULL DEFAULT TRUE,
  rows_total   INT         NOT NULL DEFAULT 0,
  rows_ok      INT         NOT NULL DEFAULT 0,
  rows_failed  INT         NOT NULL DEFAULT 0,
  errors       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  status       VARCHAR(12) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','DONE','FAILED')),
  started_by   BIGINT REFERENCES users(id),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS backups (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT      NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  kind        VARCHAR(12) NOT NULL CHECK (kind IN ('JSON','CSV','PG_DUMP')),
  filename    TEXT        NOT NULL,
  size_bytes  BIGINT      NOT NULL CHECK (size_bytes >= 0),
  sha256      CHAR(64)    NOT NULL,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HTTP-level idempotency (replays the exact response for a repeated key).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  business_id   BIGINT      NOT NULL DEFAULT fn_current_business() REFERENCES businesses(id),
  key           VARCHAR(64) NOT NULL,
  method        VARCHAR(8)  NOT NULL,
  path          TEXT        NOT NULL,
  request_hash  CHAR(64)    NOT NULL,
  status_code   INT,
  response      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 4. INDEXES
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_gc_balance          ON gift_cards (balance DESC);
CREATE INDEX IF NOT EXISTS ix_gc_status_live      ON gift_cards (status) WHERE deleted_at IS NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_gc_expires_at       ON gift_cards (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_gc_customer         ON gift_cards (customer_id);
CREATE INDEX IF NOT EXISTS ix_gc_label_lower      ON gift_cards (LOWER(label));
CREATE INDEX IF NOT EXISTS ix_gc_last_used        ON gift_cards (last_used_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS ix_gc_created          ON gift_cards (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_gc_archived         ON gift_cards (archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_gc_number_trgm      ON gift_cards USING GIN (card_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_gc_label_trgm       ON gift_cards USING GIN (label gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_cust_name_trgm      ON customers  USING GIN ((COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_cust_phone_trgm     ON customers  USING GIN (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_cust_email_trgm     ON customers  USING GIN (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_txn_card_created    ON gift_card_transactions (card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_txn_created         ON gift_card_transactions (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_txn_type_created    ON gift_card_transactions (txn_type, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_created       ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_card          ON audit_log (card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_action        ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_msglog_card         ON message_log (card_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS ix_idem_created        ON idempotency_keys (created_at);
CREATE INDEX IF NOT EXISTS ix_txn_bid_created     ON gift_card_transactions (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_bid_created   ON audit_log (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_gc_bid_status       ON gift_cards (business_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS users_bid_username_key ON users (business_id, lower(username));

-- ---------------------------------------------------------------------
-- 4b. PER-SALON KEYS, CROSS-SALON GUARDS, ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('role_permissions',       'role_permissions_pkey',        'PRIMARY KEY (business_id, role, permission)'),
    ('settings',               'settings_pkey',                'PRIMARY KEY (business_id, key)'),
    ('idempotency_keys',       'idempotency_keys_pkey',        'PRIMARY KEY (business_id, key)'),
    ('terminals',              'terminals_bid_code_key',       'UNIQUE (business_id, code)'),
    ('customers',              'customers_bid_phone_key',      'UNIQUE (business_id, phone)'),
    ('customers',              'customers_bid_id_key',         'UNIQUE (business_id, id)'),
    ('gift_cards',             'gift_cards_bid_number_key',    'UNIQUE (business_id, card_number)'),
    ('gift_cards',             'gift_cards_bid_id_key',        'UNIQUE (business_id, id)'),
    ('gift_card_transactions', 'gc_txn_bid_idem_key',          'UNIQUE (business_id, idempotency_key)'),
    ('card_tags',              'card_tags_bid_name_key',       'UNIQUE (business_id, name)'),
    ('card_tags',              'card_tags_bid_id_key',         'UNIQUE (business_id, id)'),
    ('message_templates',      'msg_tpl_bid_key_channel_key',  'UNIQUE (business_id, key, channel)'),
    -- Composite FKs: a row can only point at a card/customer/tag of the SAME salon
    -- (plain FK checks ignore RLS, so these are the hard stop for cross-salon links).
    ('gift_cards',             'gift_cards_bid_customer_fk',   'FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id)'),
    ('gift_cards',             'gift_cards_bid_replaced_fk',   'FOREIGN KEY (business_id, replaced_by_card_id) REFERENCES gift_cards (business_id, id)'),
    ('gift_card_transactions', 'gc_txn_bid_card_fk',           'FOREIGN KEY (business_id, card_id) REFERENCES gift_cards (business_id, id)'),
    ('gift_card_transactions', 'gc_txn_bid_related_fk',        'FOREIGN KEY (business_id, related_card_id) REFERENCES gift_cards (business_id, id)'),
    ('gift_card_tags',         'gift_card_tags_bid_card_fk',   'FOREIGN KEY (business_id, card_id) REFERENCES gift_cards (business_id, id) ON DELETE CASCADE'),
    ('gift_card_tags',         'gift_card_tags_bid_tag_fk',    'FOREIGN KEY (business_id, tag_id) REFERENCES card_tags (business_id, id) ON DELETE CASCADE')
  ) AS v(tbl, name, def) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.name AND conrelid = r.tbl::regclass) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', r.tbl, r.name, r.def);
    END IF;
  END LOOP;

  FOR r IN SELECT unnest(ARRAY['users','role_permissions','terminals','customers','gift_cards',
      'gift_card_transactions','audit_log','card_tags','gift_card_tags','message_templates',
      'message_log','settings','import_jobs','backups','idempotency_keys']) AS tbl LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN business_id SET DEFAULT fn_current_business()', r.tbl);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.tbl);
    -- FORCE: the policy also binds the table owner (the API's DB role) and
    -- therefore every SECURITY DEFINER fn_* below.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', r.tbl);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (business_id = fn_current_business() OR fn_system_mode())
                      WITH CHECK (business_id = fn_current_business() OR fn_system_mode())$p$, r.tbl);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 5. VIEWS
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_outstanding_liability AS
SELECT (COALESCE(SUM(balance), 0) * 100)::BIGINT AS total_cents,
       COALESCE(SUM(balance), 0)::NUMERIC(14,2)  AS total,
       COUNT(*)::INT                             AS card_count
FROM gift_cards
WHERE status IN ('ACTIVE','PARTIALUSED') AND deleted_at IS NULL;

CREATE OR REPLACE VIEW v_card_statement AS
SELECT c.id, c.card_number, c.status, c.face_value, c.balance, c.currency, c.label,
       c.expires_at, c.activation_date, c.last_used_at, c.created_at,
       cu.id AS customer_id,
       NULLIF(TRIM(COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')), '') AS holder_name,
       cu.phone AS holder_phone, cu.email AS holder_email,
       lt.txn_type AS last_txn_type, lt.amount AS last_txn_amount, lt.created_at AS last_txn_at,
       (SELECT COUNT(*) FROM gift_card_transactions t WHERE t.card_id = c.id)::INT AS txn_count
FROM gift_cards c
LEFT JOIN customers cu ON cu.id = c.customer_id
LEFT JOIN LATERAL (
  SELECT t.txn_type, t.amount, t.created_at FROM gift_card_transactions t
  WHERE t.card_id = c.id ORDER BY t.created_at DESC, t.id DESC LIMIT 1) lt ON TRUE;

CREATE OR REPLACE VIEW v_expiring_soon AS
SELECT c.id, c.card_number, c.status, c.balance, c.expires_at, c.customer_id,
       CEIL(EXTRACT(EPOCH FROM (c.expires_at - now())) / 86400)::INT AS days_left
FROM gift_cards c
WHERE c.expires_at IS NOT NULL
  AND c.expires_at BETWEEN now() AND now() + INTERVAL '30 days'
  AND c.status IN ('ACTIVE','PARTIALUSED','FROZEN')
  AND c.deleted_at IS NULL;

CREATE OR REPLACE VIEW v_zero_balance_archivable AS
SELECT c.id, c.card_number, c.status, c.face_value, c.updated_at
FROM gift_cards c
WHERE c.balance = 0
  AND c.status IN ('CLOSED','EXPIRED','VOIDED','LOST_REPLACED')
  AND c.archived_at IS NULL
  AND c.deleted_at IS NULL;

-- Unified history (money ledger + non-money audit). txn.* audit rows are
-- skipped because the ledger row already represents them.
CREATE OR REPLACE VIEW v_history AS
SELECT 'T' || t.id                    AS id,
       'TXN'                          AS kind,
       t.created_at                   AS occurred_at,
       t.actor_type, t.actor_id, u.name AS actor_name,
       t.card_id, c.card_number,
       t.txn_type::TEXT               AS action,
       t.amount, t.balance_after,
       t.external_ref                 AS reference,
       t.terminal_id, tm.code         AS terminal_code,
       t.ip, t.memo                   AS note
FROM gift_card_transactions t
JOIN gift_cards c       ON c.id = t.card_id
LEFT JOIN users u       ON u.id = t.actor_id
LEFT JOIN terminals tm  ON tm.id = t.terminal_id
UNION ALL
SELECT 'A' || a.id, 'AUDIT', a.created_at,
       a.actor_type, a.actor_id, u.name,
       a.card_id, c.card_number,
       a.action, NULL, NULL,
       a.payload->>'reference',
       a.terminal_id, tm.code,
       a.ip, COALESCE(a.payload->>'note', a.payload->>'reason')
FROM audit_log a
LEFT JOIN gift_cards c  ON c.id = a.card_id
LEFT JOIN users u       ON u.id = a.actor_id
LEFT JOIN terminals tm  ON tm.id = a.terminal_id
WHERE a.action NOT LIKE 'txn.%';

-- ---------------------------------------------------------------------
-- 6. FUNCTIONS & TRIGGERS
-- ---------------------------------------------------------------------

-- Error codes raised (SQLSTATE → API code):
--   GC400 VALIDATION         GC402 INSUFFICIENT_FUNDS   GC404 CARD_NOT_FOUND
--   GC409 STATE_CONFLICT     GC410 CARD_EXPIRED         GC423 CARD_FROZEN
--   GC424 CARD_VOIDED        GC425 IDEMPOTENCY_CONFLICT GC426 ALREADY_REVERSED

-- 6.1 updated_at touch
CREATE OR REPLACE FUNCTION fn_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gift_cards_touch_updated_at ON gift_cards;
CREATE TRIGGER trg_gift_cards_touch_updated_at
  BEFORE UPDATE ON gift_cards FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_customers_touch_updated_at ON customers;
CREATE TRIGGER trg_customers_touch_updated_at
  BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- 6.2 Append-only enforcement
CREATE OR REPLACE FUNCTION fn_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Only exception: fn_purge_business deleting a whole salon (its rows only).
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW'
     AND OLD.business_id::TEXT = current_setting('gc.purge_business', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'GC409',
    MESSAGE = format('%s is append-only: %s is not allowed', TG_TABLE_NAME, TG_OP);
END $$;

DROP TRIGGER IF EXISTS trg_txn_append_only ON gift_card_transactions;
CREATE TRIGGER trg_txn_append_only
  BEFORE UPDATE OR DELETE ON gift_card_transactions
  FOR EACH ROW EXECUTE FUNCTION fn_forbid_mutation();
DROP TRIGGER IF EXISTS trg_txn_no_truncate ON gift_card_transactions;
CREATE TRIGGER trg_txn_no_truncate
  BEFORE TRUNCATE ON gift_card_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_mutation();

DROP TRIGGER IF EXISTS trg_audit_append_only ON audit_log;
CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION fn_forbid_mutation();
DROP TRIGGER IF EXISTS trg_audit_no_truncate ON audit_log;
CREATE TRIGGER trg_audit_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_mutation();

-- 6.3 Write-path guard: balance/status may only change inside fn_* functions
CREATE OR REPLACE FUNCTION fn_gift_cards_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_path TEXT := current_setting('gc.write_path', true);
BEGIN
  IF v_path IN ('on','restore') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance <> 0 OR NEW.status <> 'PENDING_ACTIVATION' THEN
      RAISE EXCEPTION USING ERRCODE = 'GC409',
        MESSAGE = 'gift_cards must be created via fn_issue_card (balance/status are ledger-controlled)';
    END IF;
  ELSIF NEW.balance IS DISTINCT FROM OLD.balance OR NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION USING ERRCODE = 'GC409',
      MESSAGE = 'gift_cards.balance/status can only change via fn_apply_txn and friends';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gift_cards_guard ON gift_cards;
CREATE TRIGGER trg_gift_cards_guard
  BEFORE INSERT OR UPDATE ON gift_cards FOR EACH ROW EXECUTE FUNCTION fn_gift_cards_guard();

-- 6.4 Helpers
CREATE OR REPLACE FUNCTION fn_cents_to_numeric(p_cents BIGINT) RETURNS NUMERIC(12,2)
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT (p_cents::NUMERIC / 100)::NUMERIC(12,2) $$;

CREATE OR REPLACE FUNCTION fn_fmt_usd(p NUMERIC) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT '$' || to_char(COALESCE(p,0), 'FM999999990.00') $$;

-- Lifecycle rule for live cards: 0 → CLOSED, >= face → ACTIVE, else PARTIALUSED
CREATE OR REPLACE FUNCTION fn_status_for_balance(p_balance NUMERIC, p_face NUMERIC)
RETURNS card_status LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_balance = 0 THEN 'CLOSED'::card_status
              WHEN p_balance >= p_face THEN 'ACTIVE'::card_status
              ELSE 'PARTIALUSED'::card_status END
$$;

CREATE OR REPLACE FUNCTION fn_audit(
  p_actor_type actor_type, p_actor_id BIGINT, p_terminal_id BIGINT,
  p_entity_type TEXT, p_entity_id TEXT, p_card_id BIGINT,
  p_action TEXT, p_payload JSONB, p_ip INET DEFAULT NULL, p_user_agent TEXT DEFAULT NULL)
RETURNS BIGINT LANGUAGE sql AS $$
  INSERT INTO audit_log (actor_type, actor_id, terminal_id, entity_type, entity_id, card_id,
                         action, payload, ip, user_agent)
  VALUES (COALESCE(p_actor_type,'SYSTEM'), p_actor_id, p_terminal_id, p_entity_type, p_entity_id,
          p_card_id, p_action, COALESCE(p_payload,'{}'::jsonb), p_ip, p_user_agent)
  RETURNING id
$$;

-- 6.5 THE money write path ------------------------------------------------
-- p_amount_cents: signed cents for RELOAD/REDEEM/... ; ignored (NULL ok) for
-- VOID/EXPIRE/MERGE_OUT/REPLACE_OUT (always drains full balance) and
-- REVERSAL (always the negation of the reversed txn).
CREATE OR REPLACE FUNCTION fn_apply_txn(
  p_card_id         BIGINT,
  p_type            txn_type,
  p_amount_cents    BIGINT,
  p_memo            TEXT        DEFAULT NULL,
  p_external_ref    TEXT        DEFAULT NULL,
  p_actor_type      actor_type  DEFAULT 'USER',
  p_actor_id        BIGINT      DEFAULT NULL,
  p_terminal_id     BIGINT      DEFAULT NULL,
  p_ip              INET        DEFAULT NULL,
  p_user_agent      TEXT        DEFAULT NULL,
  p_idempotency_key TEXT        DEFAULT NULL,
  p_related_card_id BIGINT      DEFAULT NULL,
  p_reverses_txn_id BIGINT      DEFAULT NULL,
  p_approved_by     BIGINT      DEFAULT NULL)
RETURNS gift_card_transactions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_card    gift_cards;
  v_txn     gift_card_transactions;
  v_orig    gift_card_transactions;
  v_amount  NUMERIC(12,2);
  v_new_bal NUMERIC(12,2);
  v_status  card_status;
  v_allowed card_status[];
  v_debit   BOOLEAN;
BEGIN
  PERFORM set_config('gc.write_path', 'on', true);

  -- Lock the card first so concurrent callers serialize per card.
  SELECT * INTO v_card FROM gift_cards WHERE id = p_card_id FOR UPDATE;
  IF NOT FOUND OR v_card.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'GC404', MESSAGE = format('Gift card %s not found', p_card_id);
  END IF;

  -- Idempotent replay (checked after the lock: a racing duplicate waits, then replays).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_txn FROM gift_card_transactions WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_txn.card_id <> p_card_id OR v_txn.txn_type <> p_type
         OR (p_amount_cents IS NOT NULL AND p_type NOT IN ('VOID','EXPIRE','MERGE_OUT','REPLACE_OUT','REVERSAL')
             AND v_txn.amount <> fn_cents_to_numeric(p_amount_cents)) THEN
        RAISE EXCEPTION USING ERRCODE = 'GC425',
          MESSAGE = 'Idempotency key was already used for a different operation';
      END IF;
      RETURN v_txn;
    END IF;
  END IF;

  -- Amount resolution & sign rules
  IF p_type IN ('VOID','EXPIRE','MERGE_OUT','REPLACE_OUT') THEN
    v_amount := -v_card.balance;
  ELSIF p_type = 'REVERSAL' THEN
    SELECT * INTO v_orig FROM gift_card_transactions WHERE id = p_reverses_txn_id;
    IF NOT FOUND OR v_orig.card_id <> p_card_id THEN
      RAISE EXCEPTION USING ERRCODE = 'GC400', MESSAGE = 'Transaction to reverse not found on this card';
    END IF;
    IF v_orig.txn_type NOT IN ('REDEEM','TIP_FROM_CARD','RELOAD','REFUND_TO_CARD','ADJUSTMENT') THEN
      RAISE EXCEPTION USING ERRCODE = 'GC409',
        MESSAGE = format('%s transactions cannot be reversed', v_orig.txn_type);
    END IF;
    IF EXISTS (SELECT 1 FROM gift_card_transactions WHERE reverses_txn_id = v_orig.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'GC426', MESSAGE = 'Transaction was already reversed';
    END IF;
    v_amount := -v_orig.amount;
  ELSE
    IF p_amount_cents IS NULL OR p_amount_cents = 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'GC400', MESSAGE = 'Amount must be non-zero';
    END IF;
    v_amount := fn_cents_to_numeric(p_amount_cents);
    IF p_type IN ('ISSUE','ACTIVATE','RELOAD','REFUND_TO_CARD','TRANSFER_IN','MERGE_IN','REPLACE_IN')
       AND v_amount < 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'GC400', MESSAGE = format('%s amount must be positive', p_type);
    END IF;
    IF p_type IN ('REDEEM','TIP_FROM_CARD','TRANSFER_OUT') AND v_amount > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'GC400', MESSAGE = format('%s amount must be negative (debit)', p_type);
    END IF;
  END IF;
  v_debit := v_amount < 0;

  -- Status gate
  v_allowed := CASE p_type
    WHEN 'ISSUE'          THEN ARRAY['PENDING_ACTIVATION']
    WHEN 'ACTIVATE'       THEN ARRAY['PENDING_ACTIVATION']
    WHEN 'REPLACE_IN'     THEN ARRAY['PENDING_ACTIVATION']
    WHEN 'RELOAD'         THEN ARRAY['ACTIVE','PARTIALUSED','CLOSED']
    WHEN 'REFUND_TO_CARD' THEN ARRAY['ACTIVE','PARTIALUSED','CLOSED']
    WHEN 'REDEEM'         THEN ARRAY['ACTIVE','PARTIALUSED']
    WHEN 'TIP_FROM_CARD'  THEN ARRAY['ACTIVE','PARTIALUSED']
    WHEN 'TRANSFER_OUT'   THEN ARRAY['ACTIVE','PARTIALUSED']
    WHEN 'TRANSFER_IN'    THEN ARRAY['PENDING_ACTIVATION','ACTIVE','PARTIALUSED','CLOSED']
    WHEN 'MERGE_OUT'      THEN ARRAY['ACTIVE','PARTIALUSED']
    WHEN 'MERGE_IN'       THEN ARRAY['ACTIVE','PARTIALUSED','CLOSED']
    WHEN 'ADJUSTMENT'     THEN ARRAY['ACTIVE','PARTIALUSED','CLOSED','FROZEN']
    WHEN 'REVERSAL'       THEN ARRAY['ACTIVE','PARTIALUSED','CLOSED']
    WHEN 'VOID'           THEN ARRAY['PENDING_ACTIVATION','ACTIVE','PARTIALUSED','CLOSED','FROZEN']
    WHEN 'EXPIRE'         THEN ARRAY['PENDING_ACTIVATION','ACTIVE','PARTIALUSED','CLOSED','FROZEN']
    WHEN 'REPLACE_OUT'    THEN ARRAY['ACTIVE','PARTIALUSED','FROZEN']
  END::card_status[];

  IF NOT (v_card.status = ANY (v_allowed)) THEN
    IF v_card.status = 'FROZEN' THEN
      RAISE EXCEPTION USING ERRCODE = 'GC423',
        MESSAGE = format('Card %s is frozen%s', v_card.card_number,
                         COALESCE(': ' || v_card.freeze_reason, '')),
        DETAIL = json_build_object('card_id', v_card.id, 'status', v_card.status)::TEXT;
    ELSIF v_card.status = 'EXPIRED' THEN
      RAISE EXCEPTION USING ERRCODE = 'GC410', MESSAGE = format('Card %s has expired', v_card.card_number);
    ELSIF v_card.status IN ('VOIDED','LOST_REPLACED') THEN
      RAISE EXCEPTION USING ERRCODE = 'GC424',
        MESSAGE = format('Card %s is %s and cannot be used', v_card.card_number, v_card.status);
    ELSIF v_card.status = 'CLOSED' AND v_debit THEN
      RAISE EXCEPTION USING ERRCODE = 'GC402',
        MESSAGE = format('Insufficient: %s available', fn_fmt_usd(0)),
        DETAIL = json_build_object('available_cents', 0)::TEXT;
    ELSE
      RAISE EXCEPTION USING ERRCODE = 'GC409',
        MESSAGE = format('%s is not allowed while card is %s', p_type, v_card.status);
    END IF;
  END IF;

  -- Date-based expiry is enforced even before the nightly job runs.
  IF v_debit AND p_type IN ('REDEEM','TIP_FROM_CARD','TRANSFER_OUT','MERGE_OUT')
     AND v_card.expires_at IS NOT NULL AND v_card.expires_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'GC410',
      MESSAGE = format('Card %s expired on %s', v_card.card_number, to_char(v_card.expires_at, 'YYYY-MM-DD'));
  END IF;

  IF p_type = 'MERGE_OUT' AND v_card.balance = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'GC409', MESSAGE = 'Source card has no balance to merge';
  END IF;

  v_new_bal := v_card.balance + v_amount;
  IF v_new_bal < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'GC402',
      MESSAGE = format('Insufficient: %s available', fn_fmt_usd(v_card.balance)),
      DETAIL = json_build_object('available_cents', (v_card.balance * 100)::BIGINT,
                                 'requested_cents', (-v_amount * 100)::BIGINT)::TEXT;
  END IF;

  v_status := CASE
    WHEN p_type = 'VOID'        THEN 'VOIDED'::card_status
    WHEN p_type = 'EXPIRE'      THEN 'EXPIRED'::card_status
    WHEN p_type = 'REPLACE_OUT' THEN 'LOST_REPLACED'::card_status
    WHEN p_type = 'MERGE_OUT'   THEN 'CLOSED'::card_status
    WHEN v_card.status = 'FROZEN' THEN 'FROZEN'::card_status
    WHEN v_card.status = 'PENDING_ACTIVATION' AND v_new_bal = 0 THEN 'PENDING_ACTIVATION'::card_status
    ELSE fn_status_for_balance(v_new_bal, v_card.face_value)
  END;

  INSERT INTO gift_card_transactions (card_id, txn_type, amount, balance_after, memo, external_ref,
         related_card_id, reverses_txn_id, actor_type, actor_id, approved_by, terminal_id, ip,
         user_agent, idempotency_key)
  VALUES (p_card_id, p_type, v_amount, v_new_bal, p_memo, p_external_ref,
          p_related_card_id, CASE WHEN p_type = 'REVERSAL' THEN p_reverses_txn_id END,
          COALESCE(p_actor_type,'USER'), p_actor_id, p_approved_by, p_terminal_id, p_ip,
          p_user_agent, p_idempotency_key)
  RETURNING * INTO v_txn;

  UPDATE gift_cards SET
    balance         = v_new_bal,
    status          = v_status,
    activation_date = CASE WHEN p_type IN ('ISSUE','ACTIVATE','REPLACE_IN','TRANSFER_IN')
                           THEN COALESCE(activation_date, now()) ELSE activation_date END,
    last_used_at    = CASE WHEN p_type IN ('REDEEM','TIP_FROM_CARD') THEN now() ELSE last_used_at END,
    voided_at       = CASE WHEN p_type = 'VOID' THEN now() ELSE voided_at END,
    voided_by       = CASE WHEN p_type = 'VOID' THEN p_actor_id ELSE voided_by END,
    void_reason     = CASE WHEN p_type = 'VOID' THEN p_memo ELSE void_reason END,
    frozen_at       = CASE WHEN v_status = 'FROZEN' THEN frozen_at END,
    frozen_by       = CASE WHEN v_status = 'FROZEN' THEN frozen_by END,
    freeze_reason   = CASE WHEN v_status = 'FROZEN' THEN freeze_reason END
  WHERE id = p_card_id;

  PERFORM fn_audit(p_actor_type, p_actor_id, p_terminal_id, 'gift_card', p_card_id::TEXT, p_card_id,
    'txn.' || lower(p_type::TEXT),
    jsonb_build_object('txn_id', v_txn.id, 'amount', v_amount, 'balance_after', v_new_bal,
                       'status_before', v_card.status, 'status_after', v_status,
                       'reference', p_external_ref, 'approved_by', p_approved_by),
    p_ip, p_user_agent);

  PERFORM pg_notify('gc_events', json_build_object(
    'type', 'txn', 'business_id', v_card.business_id, 'card_id', p_card_id, 'txn_type', p_type,
    'amount_cents', (v_amount * 100)::BIGINT, 'balance_cents', (v_new_bal * 100)::BIGINT,
    'status', v_status)::TEXT);

  RETURN v_txn;
END $$;

-- 6.6 Issue a card (optionally activate immediately with an ISSUE credit)
CREATE OR REPLACE FUNCTION fn_issue_card(
  p_card_number     TEXT,
  p_face_cents      BIGINT,
  p_activate        BOOLEAN     DEFAULT TRUE,
  p_initial_cents   BIGINT      DEFAULT NULL,   -- defaults to face; < face for imported partially-used cards
  p_customer_id     BIGINT      DEFAULT NULL,
  p_label           TEXT        DEFAULT NULL,
  p_color_tag       TEXT        DEFAULT NULL,
  p_expires_at      TIMESTAMPTZ DEFAULT NULL,
  p_pin_hash        TEXT        DEFAULT NULL,
  p_channel         channel     DEFAULT 'POS',
  p_actor_type      actor_type  DEFAULT 'USER',
  p_actor_id        BIGINT      DEFAULT NULL,
  p_terminal_id     BIGINT      DEFAULT NULL,
  p_ip              INET        DEFAULT NULL,
  p_user_agent      TEXT        DEFAULT NULL,
  p_idempotency_key TEXT        DEFAULT NULL,
  p_external_ref    TEXT        DEFAULT NULL)
RETURNS gift_cards
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_number TEXT := NULLIF(upper(trim(p_card_number)), '');
  v_card   gift_cards;
  v_init   BIGINT := COALESCE(p_initial_cents, p_face_cents);
BEGIN
  PERFORM set_config('gc.write_path', 'on', true);

  IF p_idempotency_key IS NOT NULL THEN
    SELECT c.* INTO v_card FROM gift_card_transactions t JOIN gift_cards c ON c.id = t.card_id
    WHERE t.idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_card; END IF;
  END IF;

  IF p_face_cents IS NULL OR p_face_cents < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'GC400', MESSAGE = 'Face value must be >= 0';
  END IF;
  IF p_activate AND (v_init IS NULL OR v_init <= 0) THEN
    RAISE EXCEPTION USING ERRCODE = 'GC400', MESSAGE = 'Activated cards need a positive amount';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'GC400', MESSAGE = 'Expiry must be in the future';
  END IF;

  IF v_number IS NULL THEN
    LOOP
      v_number := nextval('gift_card_number_seq')::TEXT;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM gift_cards WHERE card_number = v_number);
    END LOOP;
  ELSIF EXISTS (SELECT 1 FROM gift_cards WHERE card_number = v_number) THEN
    RAISE EXCEPTION USING ERRCODE = 'GC409',
      MESSAGE = format('Card number %s already exists', v_number);
  END IF;

  INSERT INTO gift_cards (card_number, face_value, customer_id, label, color_tag, expires_at,
                          pin_hash, issue_channel, issued_by, issued_terminal)
  VALUES (v_number, fn_cents_to_numeric(p_face_cents), p_customer_id, p_label, p_color_tag,
          p_expires_at, p_pin_hash, COALESCE(p_channel,'POS'), p_actor_id, p_terminal_id)
  RETURNING * INTO v_card;

  PERFORM fn_audit(p_actor_type, p_actor_id, p_terminal_id, 'gift_card', v_card.id::TEXT, v_card.id,
    'card.issued', jsonb_build_object('card_number', v_number, 'face_value', v_card.face_value,
                                      'channel', p_channel, 'activated', p_activate),
    p_ip, p_user_agent);

  IF p_activate THEN
    PERFORM fn_apply_txn(v_card.id, 'ISSUE', v_init, 'Card issued', p_external_ref, p_actor_type,
                         p_actor_id, p_terminal_id, p_ip, p_user_agent, p_idempotency_key);
    SELECT * INTO v_card FROM gift_cards WHERE id = v_card.id;
  END IF;
  RETURN v_card;
END $$;

-- 6.7 Freeze / unfreeze (non-money status change)
CREATE OR REPLACE FUNCTION fn_set_frozen(
  p_card_id BIGINT, p_frozen BOOLEAN, p_reason TEXT,
  p_actor_type actor_type DEFAULT 'USER', p_actor_id BIGINT DEFAULT NULL,
  p_terminal_id BIGINT DEFAULT NULL, p_ip INET DEFAULT NULL, p_user_agent TEXT DEFAULT NULL)
RETURNS gift_cards
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_card gift_cards; v_new card_status;
BEGIN
  PERFORM set_config('gc.write_path', 'on', true);
  SELECT * INTO v_card FROM gift_cards WHERE id = p_card_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'GC404', MESSAGE = format('Gift card %s not found', p_card_id);
  END IF;

  IF p_frozen THEN
    IF v_card.status = 'FROZEN' THEN RETURN v_card; END IF;          -- idempotent
    IF v_card.status NOT IN ('PENDING_ACTIVATION','ACTIVE','PARTIALUSED','CLOSED') THEN
      RAISE EXCEPTION USING ERRCODE = 'GC409',
        MESSAGE = format('Cannot freeze a %s card', v_card.status);
    END IF;
    UPDATE gift_cards SET status = 'FROZEN', frozen_at = now(), frozen_by = p_actor_id,
           freeze_reason = p_reason WHERE id = p_card_id RETURNING * INTO v_card;
  ELSE
    IF v_card.status <> 'FROZEN' THEN RETURN v_card; END IF;
    v_new := CASE WHEN v_card.activation_date IS NULL AND v_card.balance = 0
                  THEN 'PENDING_ACTIVATION'::card_status
                  ELSE fn_status_for_balance(v_card.balance, v_card.face_value) END;
    UPDATE gift_cards SET status = v_new, frozen_at = NULL, frozen_by = NULL, freeze_reason = NULL
    WHERE id = p_card_id RETURNING * INTO v_card;
  END IF;

  PERFORM fn_audit(p_actor_type, p_actor_id, p_terminal_id, 'gift_card', p_card_id::TEXT, p_card_id,
    CASE WHEN p_frozen THEN 'card.frozen' ELSE 'card.unfrozen' END,
    jsonb_build_object('reason', p_reason, 'status_after', v_card.status), p_ip, p_user_agent);
  PERFORM pg_notify('gc_events', json_build_object('type','status','business_id',v_card.business_id,'card_id',p_card_id,
                                                   'status', v_card.status)::TEXT);
  RETURN v_card;
END $$;

-- 6.8 Transfer part of a balance (also used by split)
CREATE OR REPLACE FUNCTION fn_transfer(
  p_from_id BIGINT, p_to_id BIGINT, p_amount_cents BIGINT,
  p_actor_id BIGINT DEFAULT NULL, p_memo TEXT DEFAULT NULL,
  p_terminal_id BIGINT DEFAULT NULL, p_ip INET DEFAULT NULL, p_user_agent TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL, p_actor_type actor_type DEFAULT 'USER')
RETURNS TABLE (out_txn_id BIGINT, in_txn_id BIGINT, from_balance NUMERIC, to_balance NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_out gift_card_transactions; v_in gift_card_transactions;
BEGIN
  IF p_from_id = p_to_id THEN
    RAISE EXCEPTION USING ERRCODE = 'GC400', MESSAGE = 'Cannot transfer a card to itself';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'GC400', MESSAGE = 'Transfer amount must be positive';
  END IF;
  -- Deterministic lock order prevents deadlocks between opposite transfers.
  PERFORM 1 FROM gift_cards WHERE id IN (p_from_id, p_to_id) ORDER BY id FOR UPDATE;

  v_out := fn_apply_txn(p_from_id, 'TRANSFER_OUT', -p_amount_cents, COALESCE(p_memo,'Transfer out'),
             NULL, p_actor_type, p_actor_id, p_terminal_id, p_ip, p_user_agent,
             CASE WHEN p_idempotency_key IS NOT NULL THEN p_idempotency_key || ':out' END, p_to_id);
  v_in  := fn_apply_txn(p_to_id, 'TRANSFER_IN', p_amount_cents, COALESCE(p_memo,'Transfer in'),
             NULL, p_actor_type, p_actor_id, p_terminal_id, p_ip, p_user_agent,
             CASE WHEN p_idempotency_key IS NOT NULL THEN p_idempotency_key || ':in' END, p_from_id);
  RETURN QUERY SELECT v_out.id, v_in.id, v_out.balance_after, v_in.balance_after;
END $$;

-- 6.9 Merge: move the entire balance of one card into another, close source
CREATE OR REPLACE FUNCTION fn_merge(
  p_from_id BIGINT, p_to_id BIGINT, p_actor_id BIGINT DEFAULT NULL,
  p_terminal_id BIGINT DEFAULT NULL, p_ip INET DEFAULT NULL, p_user_agent TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL, p_actor_type actor_type DEFAULT 'USER')
RETURNS TABLE (out_txn_id BIGINT, in_txn_id BIGINT, moved NUMERIC, to_balance NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_out gift_card_transactions; v_in gift_card_transactions; v_to_num TEXT; v_from_num TEXT;
BEGIN
  IF p_from_id = p_to_id THEN
    RAISE EXCEPTION USING ERRCODE = 'GC400', MESSAGE = 'Cannot merge a card into itself';
  END IF;
  PERFORM 1 FROM gift_cards WHERE id IN (p_from_id, p_to_id) ORDER BY id FOR UPDATE;
  SELECT card_number INTO v_to_num FROM gift_cards WHERE id = p_to_id;
  SELECT card_number INTO v_from_num FROM gift_cards WHERE id = p_from_id;

  -- Validate the destination before draining the source.
  IF NOT EXISTS (SELECT 1 FROM gift_cards WHERE id = p_to_id AND deleted_at IS NULL
                 AND status IN ('ACTIVE','PARTIALUSED','CLOSED')) THEN
    RAISE EXCEPTION USING ERRCODE = 'GC409', MESSAGE = 'Destination card cannot receive a merge';
  END IF;

  v_out := fn_apply_txn(p_from_id, 'MERGE_OUT', NULL, 'Merged into ' || v_to_num, NULL, p_actor_type,
             p_actor_id, p_terminal_id, p_ip, p_user_agent,
             CASE WHEN p_idempotency_key IS NOT NULL THEN p_idempotency_key || ':out' END, p_to_id);
  v_in  := fn_apply_txn(p_to_id, 'MERGE_IN', (-v_out.amount * 100)::BIGINT, 'Merged from ' || v_from_num,
             NULL, p_actor_type, p_actor_id, p_terminal_id, p_ip, p_user_agent,
             CASE WHEN p_idempotency_key IS NOT NULL THEN p_idempotency_key || ':in' END, p_from_id);
  RETURN QUERY SELECT v_out.id, v_in.id, -v_out.amount, v_in.balance_after;
END $$;

-- 6.10 Split: carve an amount off into a brand-new card
CREATE OR REPLACE FUNCTION fn_split(
  p_from_id BIGINT, p_amount_cents BIGINT, p_new_number TEXT DEFAULT NULL,
  p_actor_id BIGINT DEFAULT NULL, p_terminal_id BIGINT DEFAULT NULL, p_ip INET DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL, p_idempotency_key TEXT DEFAULT NULL)
RETURNS gift_cards
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_src gift_cards; v_new gift_cards;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT c.* INTO v_new FROM gift_card_transactions t JOIN gift_cards c ON c.id = t.card_id
    WHERE t.idempotency_key = p_idempotency_key || ':in';
    IF FOUND THEN RETURN v_new; END IF;
  END IF;
  SELECT * INTO v_src FROM gift_cards WHERE id = p_from_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'GC404', MESSAGE = 'Source card not found';
  END IF;
  v_new := fn_issue_card(p_new_number, p_amount_cents, FALSE, NULL, v_src.customer_id, v_src.label,
                         v_src.color_tag, v_src.expires_at, NULL, 'POS', 'USER', p_actor_id,
                         p_terminal_id, p_ip, p_user_agent);
  PERFORM fn_transfer(p_from_id, v_new.id, p_amount_cents, p_actor_id,
                      'Split ' || v_src.card_number || ' → ' || v_new.card_number,
                      p_terminal_id, p_ip, p_user_agent, p_idempotency_key);
  SELECT * INTO v_new FROM gift_cards WHERE id = v_new.id;
  RETURN v_new;
END $$;

-- 6.11 Replace a lost card: move balance to a new number, keep audit link
CREATE OR REPLACE FUNCTION fn_replace_lost_card(
  p_old_id BIGINT, p_new_number TEXT, p_actor_id BIGINT DEFAULT NULL,
  p_terminal_id BIGINT DEFAULT NULL, p_ip INET DEFAULT NULL, p_user_agent TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL, p_reason TEXT DEFAULT 'Reported lost')
RETURNS gift_cards
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_old gift_cards; v_new gift_cards; v_out gift_card_transactions;
BEGIN
  PERFORM set_config('gc.write_path', 'on', true);
  IF p_idempotency_key IS NOT NULL THEN
    SELECT c.* INTO v_new FROM gift_card_transactions t JOIN gift_cards c ON c.id = t.card_id
    WHERE t.idempotency_key = p_idempotency_key || ':in';
    IF FOUND THEN RETURN v_new; END IF;
  END IF;

  SELECT * INTO v_old FROM gift_cards WHERE id = p_old_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'GC404', MESSAGE = 'Card to replace not found';
  END IF;
  IF v_old.balance = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'GC409', MESSAGE = 'Card has no balance to move — no replacement needed';
  END IF;

  v_new := fn_issue_card(p_new_number, (v_old.face_value * 100)::BIGINT, FALSE, NULL, v_old.customer_id,
                         v_old.label, v_old.color_tag, v_old.expires_at, v_old.pin_hash, 'POS', 'USER',
                         p_actor_id, p_terminal_id, p_ip, p_user_agent);

  v_out := fn_apply_txn(p_old_id, 'REPLACE_OUT', NULL, p_reason || ' → ' || v_new.card_number, NULL,
             'USER', p_actor_id, p_terminal_id, p_ip, p_user_agent,
             CASE WHEN p_idempotency_key IS NOT NULL THEN p_idempotency_key || ':out' END, v_new.id);
  PERFORM fn_apply_txn(v_new.id, 'REPLACE_IN', (-v_out.amount * 100)::BIGINT,
             'Replacement for ' || v_old.card_number, NULL, 'USER', p_actor_id, p_terminal_id, p_ip,
             p_user_agent, CASE WHEN p_idempotency_key IS NOT NULL THEN p_idempotency_key || ':in' END,
             p_old_id);

  UPDATE gift_cards SET replaced_by_card_id = v_new.id WHERE id = p_old_id;
  PERFORM fn_audit('USER', p_actor_id, p_terminal_id, 'gift_card', p_old_id::TEXT, p_old_id,
    'card.replaced', jsonb_build_object('new_card_id', v_new.id, 'new_card_number', v_new.card_number,
                                        'reason', p_reason), p_ip, p_user_agent);
  SELECT * INTO v_new FROM gift_cards WHERE id = v_new.id;
  RETURN v_new;
END $$;

-- 6.12 Reverse a transaction (undo toast, mistaken reload, ...)
CREATE OR REPLACE FUNCTION fn_reverse_txn(
  p_txn_id BIGINT, p_reason TEXT, p_actor_id BIGINT DEFAULT NULL,
  p_terminal_id BIGINT DEFAULT NULL, p_ip INET DEFAULT NULL, p_user_agent TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL, p_approved_by BIGINT DEFAULT NULL)
RETURNS gift_card_transactions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_card_id BIGINT;
BEGIN
  SELECT card_id INTO v_card_id FROM gift_card_transactions WHERE id = p_txn_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'GC404', MESSAGE = 'Transaction not found';
  END IF;
  RETURN fn_apply_txn(v_card_id, 'REVERSAL', NULL, COALESCE(p_reason, 'Reversal of #' || p_txn_id), NULL,
                      'USER', p_actor_id, p_terminal_id, p_ip, p_user_agent, p_idempotency_key, NULL,
                      p_txn_id, p_approved_by);
END $$;

-- 6.13 Clear Zero-Balance (archive) + 30-day undo
CREATE OR REPLACE FUNCTION fn_archive_zero_balance(
  p_dry_run BOOLEAN DEFAULT TRUE, p_actor_id BIGINT DEFAULT NULL,
  p_terminal_id BIGINT DEFAULT NULL, p_ip INET DEFAULT NULL)
RETURNS TABLE (card_id BIGINT, card_number VARCHAR, status card_status, face_value NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_count INT; v_face NUMERIC;
BEGIN
  IF p_dry_run THEN
    RETURN QUERY SELECT v.id, v.card_number, v.status, v.face_value
                 FROM v_zero_balance_archivable v ORDER BY v.id;
    RETURN;
  END IF;

  RETURN QUERY
  WITH a AS (
    UPDATE gift_cards g SET archived_at = now(), archived_by = p_actor_id
    WHERE g.id IN (SELECT v.id FROM v_zero_balance_archivable v)
    RETURNING g.id, g.card_number, g.status, g.face_value)
  SELECT a.id, a.card_number, a.status, a.face_value FROM a ORDER BY a.id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  -- archived_at = now() identifies exactly the rows archived by this transaction
  SELECT COALESCE(SUM(g.face_value),0) INTO v_face FROM gift_cards g WHERE g.archived_at = now();
  PERFORM fn_audit('USER', p_actor_id, p_terminal_id, 'gift_card', NULL, NULL, 'cards.archived_zero_balance',
                   jsonb_build_object('count', v_count, 'face_value_total', v_face), p_ip);
END $$;

CREATE OR REPLACE FUNCTION fn_restore_archived(
  p_card_ids BIGINT[], p_actor_id BIGINT DEFAULT NULL, p_terminal_id BIGINT DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_count INT;
BEGIN
  UPDATE gift_cards SET archived_at = NULL, archived_by = NULL
  WHERE id = ANY (p_card_ids) AND archived_at IS NOT NULL
    AND archived_at >= now() - INTERVAL '30 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM fn_audit('USER', p_actor_id, p_terminal_id, 'gift_card', NULL, NULL, 'cards.archive_restored',
                   jsonb_build_object('card_ids', p_card_ids, 'restored', v_count));
  RETURN v_count;
END $$;

-- 6.14 Nightly expiry (pg_cron or app scheduler)
-- With a salon set: that salon only. With none (pg_cron, run-job): every
-- active salon, each under its own RLS context.
CREATE OR REPLACE FUNCTION fn_expire_due_cards() RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r RECORD; b RECORD; v_n INT := 0; v_prev TEXT := current_setting('app.business_id', true);
BEGIN
  FOR b IN SELECT id FROM businesses
           WHERE (v_prev IS NULL OR v_prev = '') AND status = 'ACTIVE'
           UNION ALL SELECT NULLIF(v_prev, '')::BIGINT WHERE NULLIF(v_prev, '') IS NOT NULL
           ORDER BY 1
  LOOP
    PERFORM set_config('app.business_id', b.id::TEXT, true);
    FOR r IN SELECT id FROM gift_cards
             WHERE expires_at IS NOT NULL AND expires_at <= now() AND deleted_at IS NULL
               AND status IN ('PENDING_ACTIVATION','ACTIVE','PARTIALUSED','CLOSED','FROZEN')
             ORDER BY id
    LOOP
      PERFORM fn_apply_txn(r.id, 'EXPIRE', NULL, 'Expired (nightly job)', NULL, 'SYSTEM', NULL, NULL,
                           NULL, NULL, 'expire:' || r.id);
      v_n := v_n + 1;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.business_id', COALESCE(v_prev, ''), true);
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION fn_expiring_soon(p_days INT DEFAULT 30)
RETURNS TABLE (id BIGINT, card_number VARCHAR, status card_status, balance NUMERIC,
               expires_at TIMESTAMPTZ, customer_id BIGINT, days_left INT)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.card_number, c.status, c.balance, c.expires_at, c.customer_id,
         CEIL(EXTRACT(EPOCH FROM (c.expires_at - now())) / 86400)::INT
  FROM gift_cards c
  WHERE c.expires_at IS NOT NULL
    AND c.expires_at BETWEEN now() AND now() + make_interval(days => p_days)
    AND c.status IN ('ACTIVE','PARTIALUSED','FROZEN') AND c.deleted_at IS NULL
  ORDER BY c.expires_at
$$;

-- 6.15 GDPR erase: blank PII, keep financial history intact
CREATE OR REPLACE FUNCTION fn_erase_customer(p_customer_id BIGINT, p_actor_id BIGINT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE customers SET first_name = NULL, last_name = NULL, phone = NULL, email = NULL,
         notes = NULL, marketing_opt_in = FALSE, erased_at = now()
  WHERE id = p_customer_id AND erased_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'GC404', MESSAGE = 'Customer not found or already erased';
  END IF;
  UPDATE message_log SET recipient = NULL WHERE customer_id = p_customer_id;
  PERFORM fn_audit('USER', p_actor_id, NULL, 'customer', p_customer_id::TEXT, NULL, 'customer.erased',
                   jsonb_build_object('note', 'GDPR erasure'));
END $$;

-- 6.15b Delete a whole salon (platform admin). Runs inside that salon's RLS
--       context, so even a bug here cannot touch another salon's rows.
CREATE OR REPLACE FUNCTION fn_purge_business(p_bid BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_counts JSONB := '{}'::jsonb; v_n INT; t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = p_bid) THEN
    RAISE EXCEPTION USING ERRCODE = 'GC404', MESSAGE = 'Salon not found';
  END IF;
  PERFORM set_config('app.system', '', true);
  PERFORM set_config('app.business_id', p_bid::TEXT, true);
  PERFORM set_config('gc.purge_business', p_bid::TEXT, true);
  -- children before parents
  FOREACH t IN ARRAY ARRAY['gift_card_tags','message_log','audit_log','gift_card_transactions','gift_cards',
      'customers','card_tags','message_templates','settings','role_permissions','import_jobs','backups',
      'idempotency_keys','terminals','users'] LOOP
    EXECUTE format('DELETE FROM %I WHERE business_id = $1', t) USING p_bid;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object(t, v_n);
  END LOOP;
  DELETE FROM businesses WHERE id = p_bid;
  PERFORM set_config('gc.purge_business', '', true);
  PERFORM set_config('app.business_id', '', true);
  RETURN v_counts;
END $$;

-- 6.16 Optional pg_cron schedule (silently skipped when pg_cron is unavailable;
--      the API's node scheduler runs the same job).
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('gc-expire-nightly', '5 0 * * *', 'SELECT fn_expire_due_cards()');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available — use the API scheduler (JOBS_ENABLED=true)';
END $$;

-- ---------------------------------------------------------------------
-- 7. REFERENCE SEED (per salon; idempotent, re-run for every salon on each migrate
--    so new default templates/settings reach existing salons too)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_seed_business(p_bid BIGINT, p_name TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_prev TEXT := current_setting('app.business_id', true);
BEGIN
  PERFORM set_config('app.business_id', p_bid::TEXT, true);
  INSERT INTO role_permissions (role, permission)
  SELECT r::role_name, p FROM (VALUES
    ('OWNER','*'),
    ('MANAGER','dashboard.read'),('MANAGER','cards.read'),('MANAGER','cards.issue'),
    ('MANAGER','cards.reload'),('MANAGER','cards.redeem'),('MANAGER','cards.freeze'),
    ('MANAGER','cards.refund'),('MANAGER','cards.adjust'),('MANAGER','cards.void'),
    ('MANAGER','cards.transfer'),('MANAGER','cards.merge'),('MANAGER','cards.replace'),
    ('MANAGER','cards.edit'),('MANAGER','cards.delete'),('MANAGER','cards.archive'),
    ('MANAGER','cards.export'),('MANAGER','cards.print'),('MANAGER','cards.send'),
    ('MANAGER','cards.reverse'),('MANAGER','history.read'),('MANAGER','history.export'),
    ('MANAGER','customers.read'),('MANAGER','customers.write'),('MANAGER','customers.erase'),
    ('MANAGER','settings.read'),('MANAGER','settings.write'),('MANAGER','import.run'),
    ('MANAGER','data.export'),('MANAGER','data.backup'),('MANAGER','approve'),
    ('STAFF','dashboard.read'),('STAFF','cards.read'),('STAFF','cards.issue'),
    ('STAFF','cards.reload'),('STAFF','cards.redeem'),('STAFF','cards.freeze'),
    ('STAFF','cards.edit'),('STAFF','cards.print'),('STAFF','cards.send'),
    ('STAFF','cards.reverse'),('STAFF','cards.transfer'),('STAFF','history.read'),
    ('STAFF','customers.read'),('STAFF','customers.write'),('STAFF','settings.read'),
    ('KIOSK','kiosk.lookup')
  ) AS v(r, p)
  ON CONFLICT DO NOTHING;

  INSERT INTO settings (key, value) VALUES
    ('general',   jsonb_build_object('business_name', p_name) || '{"address":"","phone":"","logo_url":"","timezone":"America/Chicago","currency":"USD","tax_rate_bps":0,"tax_on_card_sale":false}'::jsonb),
    ('receipt',   jsonb_build_object('header', p_name || E'\nThank you!') || '{"footer":"Gift cards are not redeemable for cash.","show_balance_after":true,"show_terms":true,"terms":"No cash value except where required by law. Treat like cash; not replaced if lost unless registered.","show_barcode":true}'::jsonb),
    ('printer',   '{"mode":"browser","host":"","port":9100,"paper_width_mm":80,"auto_print":{"issue":true,"redeem":true,"reload":true,"refund":false},"copies":1}'),
    ('messaging', '{"email_provider":"log","sms_provider":"log","from_email":"","from_sms":"","low_balance_threshold_cents":1000,"expiry_warning_days":[7,3,1],"send_low_balance":true,"send_reload_thanks":true}'),
    ('terminal',  '{"gateway":"stub","gateway_public_key":"","gateway_mode":"sandbox"}'),
    ('security',  '{"session_timeout_min":480,"activity_lock_min":5,"approval_threshold_cents":50000,"dual_control_refunds":true,"dual_control_voids":true,"pin_max_attempts":5,"pin_lockout_min":15,"undo_window_sec":10,"offline_max_redeem_cents":10000}'),
    ('loyalty',   '{"enabled":false,"points_per_dollar":1}')
  ON CONFLICT (business_id, key) DO NOTHING;

  INSERT INTO message_templates (key, channel, subject, body) VALUES
    ('card_delivered','EMAIL','Your {{business_name}} gift card','Hi {{first_name}}, your gift card {{card_masked}} is loaded with {{balance}}. Check your balance anytime: {{kiosk_url}}'),
    ('card_delivered','SMS',  NULL,'{{business_name}}: your gift card {{card_masked}} has {{balance}}. Balance: {{kiosk_url}}'),
    ('low_balance','EMAIL','Your gift card is running low','Hi {{first_name}}, card {{card_masked}} has {{balance}} left. Reload at the front desk anytime.'),
    ('low_balance','SMS',  NULL,'{{business_name}}: card {{card_masked}} has {{balance}} left.'),
    ('reload_thanks','EMAIL','Thanks for reloading!','Hi {{first_name}}, we added {{amount}} to card {{card_masked}}. New balance: {{balance}}.'),
    ('reload_thanks','SMS',  NULL,'{{business_name}}: +{{amount}} added. Card {{card_masked}} balance {{balance}}.'),
    ('expiry_warning','EMAIL','Your gift card expires in {{days_left}} day(s)','Hi {{first_name}}, card {{card_masked}} ({{balance}}) expires on {{expires_on}}. Book a visit to use it!'),
    ('expiry_warning','SMS',  NULL,'{{business_name}}: card {{card_masked}} ({{balance}}) expires {{expires_on}}.')
  ON CONFLICT (business_id, key, channel) DO NOTHING;

  INSERT INTO card_tags (name, color) VALUES
    ('Birthday','pink'),('Promo','violet'),('Corporate','sky'),('VIP','amber'),('Comp','slate')
  ON CONFLICT (business_id, name) DO NOTHING;

  PERFORM set_config('app.business_id', COALESCE(v_prev, ''), true);
END $$;

DO $$
DECLARE b RECORD;
BEGIN
  FOR b IN SELECT id, name FROM businesses ORDER BY id LOOP
    PERFORM fn_seed_business(b.id, b.name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 8. DEMO SEED (matches the source POS screenshot; outstanding = $635.00)
--    Users:     owner/owner123 PIN 1111 · manager/manager123 PIN 2222 · staff PIN 3333
--    Terminals: FRONT-DESK-1 key "dev-frontdesk-key" · KIOSK-1 key "dev-kiosk-key"
--    Card PINs: 1234 (kiosk demo)
-- ---------------------------------------------------------------------
--    Salon:     slug "amazing-salon"
DO $$
DECLARE v_owner BIGINT; v_term BIGINT; v_card gift_cards; v_pin TEXT; v_bid BIGINT;
BEGIN
  IF current_setting('gc.skip_demo_seed', true) = 'on' THEN
    RAISE NOTICE 'Skipping demo seed'; RETURN;
  END IF;

  INSERT INTO businesses (slug, name) VALUES ('amazing-salon', 'Amazing Salon')
  ON CONFLICT (slug) DO NOTHING;
  SELECT id INTO v_bid FROM businesses WHERE slug = 'amazing-salon';
  PERFORM fn_seed_business(v_bid, 'Amazing Salon');
  PERFORM set_config('app.business_id', v_bid::TEXT, true);

  INSERT INTO users (name, username, pin_hash, password_hash, role) VALUES
    ('Owner',   'owner',   crypt('1111', gen_salt('bf', 10)), crypt('owner123',   gen_salt('bf', 10)), 'OWNER'),
    ('Manager', 'manager', crypt('2222', gen_salt('bf', 10)), crypt('manager123', gen_salt('bf', 10)), 'MANAGER'),
    ('Front Desk', 'staff', crypt('3333', gen_salt('bf', 10)), NULL, 'STAFF')
  ON CONFLICT DO NOTHING;

  INSERT INTO terminals (code, name, kind, api_key_hash) VALUES
    ('FRONT-DESK-1', 'Front desk iPad', 'POS',   encode(digest('dev-frontdesk-key', 'sha256'), 'hex')),
    ('KIOSK-1',      'Customer kiosk',  'KIOSK', encode(digest('dev-kiosk-key', 'sha256'), 'hex'))
  ON CONFLICT (business_id, code) DO NOTHING;

  IF EXISTS (SELECT 1 FROM gift_cards WHERE card_number IN ('3460001','3460002','3460003','3460010')) THEN
    PERFORM set_config('app.business_id', '', true);
    RETURN;
  END IF;

  SELECT id INTO v_owner FROM users WHERE username = 'owner';
  SELECT id INTO v_term  FROM terminals WHERE code = 'FRONT-DESK-1';
  v_pin := crypt('1234', gen_salt('bf', 10));

  -- 3460001: $100 → redeemed $85 → $15.00 PARTIALUSED
  v_card := fn_issue_card('3460001', 10000, TRUE, NULL, NULL, NULL, NULL, NULL, v_pin, 'POS', 'USER', v_owner, v_term);
  PERFORM fn_apply_txn(v_card.id, 'REDEEM', -8500, 'Gel manicure + pedicure', 'T-1001', 'USER', v_owner, v_term);
  -- 3460002: $100 → redeemed $2 → $98.00 PARTIALUSED
  v_card := fn_issue_card('3460002', 10000, TRUE, NULL, NULL, NULL, NULL, NULL, v_pin, 'POS', 'USER', v_owner, v_term);
  PERFORM fn_apply_txn(v_card.id, 'REDEEM', -200, 'Nail art add-on', 'T-1002', 'USER', v_owner, v_term);
  -- 3460003: $50 → redeemed $28 → $22.00 PARTIALUSED
  v_card := fn_issue_card('3460003', 5000, TRUE, NULL, NULL, NULL, NULL, NULL, v_pin, 'POS', 'USER', v_owner, v_term);
  PERFORM fn_apply_txn(v_card.id, 'REDEEM', -2800, 'Classic pedicure', 'T-1003', 'USER', v_owner, v_term);
  -- 3460010: $500 → untouched → $500.00 ACTIVE
  v_card := fn_issue_card('3460010', 50000, TRUE, NULL, NULL, NULL, NULL, NULL, v_pin, 'POS', 'USER', v_owner, v_term);
  PERFORM set_config('app.business_id', '', true);
END $$;

COMMIT;
