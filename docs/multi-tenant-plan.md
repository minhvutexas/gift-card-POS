# Multi-salon (multi-tenant) plan

Goal: many salons sign up on one server. Each salon sees only its own
cards, customers, staff, history and settings. Same stack as today:
Express API + React (Vite) + PostgreSQL on Ubuntu.

Status: **plan only. No code written yet.**

---

## 1. How isolation works (two locks)

1. **App lock.** Every request knows its salon (`business_id`). The API
   only ever queries with that salon set.
2. **Database lock (Row Level Security).** Even if app code has a bug,
   Postgres itself hides other salons' rows.

How the DB lock works:

- New table `businesses`. Every salon-owned table gets
  `business_id BIGINT NOT NULL REFERENCES businesses(id)`.
- RLS policy on each table:
  `business_id = current_setting('app.business_id')::bigint`.
- The API connects as a new role `giftcard_app`: no superuser, not table
  owner, and `FORCE ROW LEVEL SECURITY` on every table. So RLS cannot be
  skipped by accident.
- Each request runs in a transaction that begins with
  `SET LOCAL app.business_id = <id>`. No salon set → zero rows visible.
- A second role, `giftcard_system` (BYPASSRLS), is used **only** for
  signup, the nightly jobs, and the platform admin screen.

## 2. Database changes (`db/migrations/001_multi_tenant.sql`)

New table:

```sql
CREATE TABLE businesses (
  id          BIGSERIAL PRIMARY KEY,
  slug        VARCHAR(40) NOT NULL UNIQUE,   -- used in login + kiosk URL
  name        VARCHAR(80) NOT NULL,
  status      VARCHAR(12) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | SUSPENDED
  owner_email VARCHAR(120) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Gets `business_id` + RLS (14 tables):
users, terminals, customers, gift_cards, gift_card_transactions,
audit_log, card_tags, gift_card_tags, message_templates, message_log,
settings, import_jobs, backups, idempotency_keys.

Stays global: role_permissions, schema_migrations, businesses.

Unique rules change from "unique everywhere" to "unique per salon":

| Table | Before | After |
|---|---|---|
| users | `username` | `(business_id, lower(username))` |
| terminals | `code` | `(business_id, code)` |
| customers | `phone` | `(business_id, phone)` |
| gift_cards | `card_number` | `(business_id, card_number)` |
| gift_card_transactions | `idempotency_key` | `(business_id, idempotency_key)` |
| card_tags | `name` | `(business_id, name)` |
| message_templates | `(key, channel)` | `(business_id, key, channel)` |
| settings | PK `key` | PK `(business_id, key)` |
| idempotency_keys | PK `key` | PK `(business_id, key)` |

Extra safety: money tables use composite foreign keys
`(business_id, card_id) → gift_cards(business_id, id)`. Then a
transaction can never point at another salon's card, even by mistake.

**The 12 `SECURITY DEFINER` functions** (`fn_apply_txn`, `fn_issue_card`,
`fn_transfer`, `fn_merge`, …) run as the table owner, so they skip RLS.
Each one gets an explicit check: the card's `business_id` must equal
`current_setting('app.business_id')`, else raise `NOT_FOUND`. This is
the most important part to get right and test.

`pg_notify` payloads gain `business_id`. Live updates are filtered so a
salon only gets its own events.

New function `fn_seed_business(business_id)` copies the default
settings, message templates and tags for a new salon. It replaces the
global reference seed.

**Existing data:** the migration creates business #1 "Amazing Salon"
and puts every current row under it. Nothing is lost.

## 3. API changes

| Area | Change |
|---|---|
| `db.ts` | A tenant-scoped client per request (AsyncLocalStorage). `query()`, `one()` and `withTx()` all run with `SET LOCAL app.business_id`. Routes barely change, because they already go through these helpers. |
| Login | Salon is found from: (1) the terminal key (each terminal belongs to one salon), or (2) salon slug + username + password. The JWT gets a `bid` claim. Every request checks the JWT `bid` matches the terminal's salon. |
| Kiosk | Public balance page moves to `/k/:slug`. The rate limit is per salon + IP. |
| Settings cache | Keyed by salon. |
| Idempotency | Keys scoped per salon. |
| Nightly jobs | Run per salon (system role). Each salon's own timezone and messaging settings apply. |
| Live events (SSE) | Filtered by salon. |
| Backup / export | "Download my data" exports only that salon (RLS makes it automatic). Restore only into an empty salon. Full-server `pg_dump` stays a server-level cron job. |
| Suspended salon | All requests get `403 BUSINESS_SUSPENDED`. |

New endpoints:

- `POST /api/v1/signup`: salon name, slug, owner name, email, password.
  It creates the business, seeds defaults, creates the owner and the first
  terminal, and pairs the current browser. Rate-limited.
- `GET /api/v1/signup/slug-available?slug=`
- Platform admin (`/api/v1/platform/*`, separate super-admin login from
  server `.env`): list salons, suspend or reactivate, see counts.

## 4. Web changes

- `/signup`: create a salon.
- `/login`: if this device is not paired, ask for "Salon ID" (slug)
  once, then username/password or PIN as today.
- `/k/:slug`: public kiosk for that salon.
- `/platform`: super-admin screen.
- Salon name comes from settings (already done today). No other UI
  changes.

## 5. Tests (the proof)

- **Isolation suite:** make salons A and B. For every endpoint, B tries
  A's card, customer, user, terminal and txn ids → must get 404. List
  endpoints must never return the other salon's rows.
- **DB-level test:** connect as `giftcard_app` with no salon set → every
  table returns 0 rows. With the wrong salon set → 0 rows. Each
  SECURITY DEFINER function called with another salon's card → error.
- **Same card number** in two salons works, and each salon sees its own.
- **Existing tests** keep passing, run against business #1.

## 6. Deploy changes

- `install.sh` creates two DB roles (`giftcard_app`, `giftcard_system`)
  with separate passwords in `.env`.
- `setup:owner` becomes `setup:platform-admin`. Salons sign up through
  the web page.
- Same one-command install and update.

## 7. Phases

1. **DB:** businesses table, business_id columns, per-salon unique
   rules, RLS, roles, migration of existing data, DB isolation tests.
2. **API:** tenant context, login/JWT, kiosk, jobs, events, settings,
   idempotency, backup. Isolation suite.
3. **Signup + UI:** signup page, login changes, kiosk URL, platform admin.
4. **Deploy:** installer, docs.
5. **Later (not in v1):** billing (Stripe), email verify + forgot
   password, custom subdomains (`salon.yourapp.com`), per-salon usage
   limits.

Each phase is one commit, tested before the next.

## 8. Open questions

- **Billing:** charge salons now (Stripe) or free at first?
- **Login address:** path + Salon ID (simple, works with today's HTTPS
  setup) or subdomain per salon (nicer, but needs wildcard DNS + a
  wildcard certificate)?
- **Email:** forgot-password and email verification need an email
  sender (SendGrid key already supported). Have one?
