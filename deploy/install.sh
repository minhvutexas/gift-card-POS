#!/usr/bin/env bash
# One-shot installer for Ubuntu 22.04 / 24.04.
#
#   git clone https://github.com/minhvutexas/gift-card-POS.git /tmp/gc
#   sudo DOMAIN=pos.example.com EMAIL=you@example.com bash /tmp/gc/deploy/install.sh
#
# Installs Node 22, PostgreSQL, Nginx, builds the app into /opt/giftcard,
# creates a clean database (no demo data), runs it as a systemd service,
# and (if EMAIL is set and DNS points here) gets an HTTPS certificate.
# Safe to re-run: existing database, secrets and .env are kept.
set -euo pipefail

: "${DOMAIN:?Set DOMAIN, e.g. sudo DOMAIN=pos.example.com bash install.sh}"
EMAIL="${EMAIL:-}"
APP=/opt/giftcard
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_URL="${REPO_URL:-$(git -C "$SRC" remote get-url origin 2>/dev/null || true)}"

[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
log() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }

log "Packages"
apt-get update -y
apt-get install -y ca-certificates curl git postgresql nginx ufw
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

log "System user"
id giftcard >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/giftcard --shell /usr/sbin/nologin giftcard

log "Code -> $APP"
if [ ! -d "$APP/.git" ]; then
  if [ -n "$REPO_URL" ]; then git clone "$REPO_URL" "$APP"; else cp -a "$SRC" "$APP"; fi
fi
rm -rf "$APP/api/.pgdata"
chown -R giftcard:giftcard "$APP"
git config --system --add safe.directory "$APP" || true

log "Database"
ENV="$APP/api/.env"
if [ -f "$ENV" ]; then
  DB_PASS="$(sed -n 's|^DATABASE_URL=postgres://giftcard:\([^@]*\)@.*|\1|p' "$ENV")"
else
  DB_PASS="$(openssl rand -hex 24)"
fi
# NOSUPERUSER NOBYPASSRLS: row-level security is the wall between salons.
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='giftcard'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE giftcard LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '$DB_PASS'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='giftcard'" | grep -q 1 \
  || sudo -u postgres createdb -O giftcard giftcard
sudo -u postgres psql -d giftcard -c "CREATE EXTENSION IF NOT EXISTS pgcrypto" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"

log "Config $ENV"
if [ ! -f "$ENV" ]; then
  sed -e "s|DB_PASSWORD|$DB_PASS|" \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" \
      -e "s|^QR_SECRET=.*|QR_SECRET=$(openssl rand -hex 32)|" \
      -e "s|pos.example.com|$DOMAIN|g" \
      "$APP/deploy/giftcard.env.example" > "$ENV"
fi
chown giftcard:giftcard "$ENV"; chmod 600 "$ENV"
install -d -o giftcard -g giftcard -m 750 /var/backups/giftcard

log "Build"
sudo -u giftcard -H bash -c "cd $APP/api && rm -rf node_modules && npm ci --no-audit --no-fund && npm run build"
sudo -u giftcard -H bash -c "cd $APP/web && rm -rf node_modules && npm ci --no-audit --no-fund && npm run build"

log "Migrate (no demo data)"
sudo -u giftcard -H bash -c "cd $APP/api && set -a && . ./.env && set +a && SKIP_DEMO_SEED=true npm run db:migrate"

log "Service"
install -m 644 "$APP/deploy/giftcard-api.service" /etc/systemd/system/giftcard-api.service
systemctl daemon-reload
systemctl enable giftcard-api
systemctl restart giftcard-api

log "Nginx"
sed "s|DOMAIN|$DOMAIN|g" "$APP/deploy/nginx-giftcard.conf" > /etc/nginx/sites-available/giftcard
ln -sf /etc/nginx/sites-available/giftcard /etc/nginx/sites-enabled/giftcard
rm -f /etc/nginx/sites-enabled/default
chmod o+x /opt "$APP" "$APP/web"
nginx -t && systemctl reload nginx

log "Firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

log "Nightly backup"
install -m 755 "$APP/deploy/backup.sh" /etc/cron.daily/giftcard-backup

if [ -n "$EMAIL" ]; then
  log "HTTPS"
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect \
    || echo "certbot failed: check DNS for $DOMAIN points to this server, then run: sudo certbot --nginx -d $DOMAIN"
fi

sleep 2
curl -fsS http://127.0.0.1:4000/health >/dev/null && echo "API healthy" || { echo "API not healthy: journalctl -u giftcard-api -n 50"; exit 1; }

if ! sudo -u postgres psql -d giftcard -tAc "SELECT 1 FROM businesses LIMIT 1" | grep -q 1; then
  log "Create your first salon + owner login"
  sudo -u giftcard -H bash -c "cd $APP/api && set -a && . ./.env && set +a && npm run --silent setup:owner" </dev/tty
fi

log "Done -> https://$DOMAIN"
