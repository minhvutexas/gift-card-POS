#!/usr/bin/env bash
# One-shot installer for Ubuntu 22.04 / 24.04.
#
#   git clone https://github.com/minhvutexas/gift-card-POS.git /tmp/gc
#   sudo DOMAIN=pos.example.com EMAIL=you@example.com bash /tmp/gc/deploy/install.sh
#
# Behind a home router / no open ports? Use a Cloudflare Tunnel instead:
#   sudo DOMAIN=pos.example.com TUNNEL=1 bash /tmp/gc/deploy/install.sh
# (asks for the tunnel token from Cloudflare Zero Trust → Networks → Tunnels;
#  Cloudflare then serves HTTPS, so no certificate, port 80/443 or fixed IP is needed)
#
# Installs Node 22, PostgreSQL, Nginx, builds the app into /opt/giftcard,
# creates a clean database (no demo data), runs it as a systemd service,
# and (if EMAIL is set and DNS points here) gets an HTTPS certificate.
# Safe to re-run: existing database, secrets and .env are kept.
set -euo pipefail

: "${DOMAIN:?Set DOMAIN, e.g. sudo DOMAIN=pos.example.com bash install.sh}"
EMAIL="${EMAIL:-}"
TUNNEL="${TUNNEL:-0}"
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
  # Same branch as the copy this script runs from (so a feature branch installs itself).
  BRANCH="${BRANCH:-$(git -C "$SRC" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
  if [ -n "$REPO_URL" ]; then git clone -b "$BRANCH" "$REPO_URL" "$APP"; else cp -a "$SRC" "$APP"; fi
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
      -e "s|^PLATFORM_ADMIN_PASSWORD=.*|PLATFORM_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=')|" \
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
if [ "$TUNNEL" = 1 ]; then
  # Only the local tunnel talks to Nginx. Take the visitor's real IP from
  # Cloudflare's header (trusted from localhost only) so rate limits are per
  # customer, and tell the app the outside connection is HTTPS.
  sed -i -e 's|^    listen 80;|    listen 127.0.0.1:80;\n    set_real_ip_from 127.0.0.1;\n    real_ip_header CF-Connecting-IP;|' \
         -e '/^    listen \[::\]:80;/d' \
         -e 's|proxy_set_header X-Forwarded-Proto \$scheme;|proxy_set_header X-Forwarded-Proto https;|' \
         /etc/nginx/sites-available/giftcard
fi
ln -sf /etc/nginx/sites-available/giftcard /etc/nginx/sites-enabled/giftcard
rm -f /etc/nginx/sites-enabled/default
chmod o+x /opt "$APP" "$APP/web"
nginx -t && systemctl reload nginx

log "Firewall"
ufw allow OpenSSH
if [ "$TUNNEL" = 1 ]; then
  ufw delete allow 'Nginx Full' >/dev/null 2>&1 || true   # tunnel: no inbound web ports
else
  ufw allow 'Nginx Full'
fi
ufw --force enable

log "Nightly backup"
install -m 755 "$APP/deploy/backup.sh" /etc/cron.daily/giftcard-backup

if [ "$TUNNEL" = 1 ]; then
  log "Cloudflare Tunnel"
  if ! command -v cloudflared >/dev/null; then
    mkdir -p --mode=0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -y && apt-get install -y cloudflared
  fi
  if systemctl is-active --quiet cloudflared; then
    echo "cloudflared already running — keeping its tunnel"
  else
    echo "Paste the tunnel token (the long text after 'cloudflared service install'). It is not shown."
    read -rs CF_TOKEN </dev/tty; echo
    [ -n "$CF_TOKEN" ] || { echo "No token given. Re-run this script when you have it."; exit 1; }
    cloudflared service install "$CF_TOKEN"
    unset CF_TOKEN
  fi
elif [ -n "$EMAIL" ]; then
  log "HTTPS"
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect \
    || echo "certbot failed: check DNS for $DOMAIN points to this server, then run: sudo certbot --nginx -d $DOMAIN"
fi

sleep 2
curl -fsS http://127.0.0.1:4000/health >/dev/null && echo "API healthy" || { echo "API not healthy: journalctl -u giftcard-api -n 50"; exit 1; }

log "Done -> https://$DOMAIN"
echo "  Salons sign up at:   https://$DOMAIN/signup"
echo "  Your admin page:     https://$DOMAIN/platform"
echo "  Admin password:      $(sed -n 's/^PLATFORM_ADMIN_PASSWORD=//p' "$ENV")   (in $ENV)"
echo "  Create a salon from the terminal instead: cd $APP/api && sudo -u giftcard npm run setup:owner"
