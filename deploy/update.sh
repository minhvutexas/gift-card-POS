#!/usr/bin/env bash
# Pull latest code, rebuild, migrate, restart.   sudo bash /opt/giftcard/deploy/update.sh
set -euo pipefail
APP=/opt/giftcard
cd "$APP"
sudo -u giftcard git pull --ff-only
sudo -u giftcard bash -c "cd api && npm ci --no-audit --no-fund && npm run build"
sudo -u giftcard bash -c "cd web && npm ci --no-audit --no-fund && npm run build"
sudo -u giftcard bash -c "cd api && set -a && . ./.env && set +a && SKIP_DEMO_SEED=true npm run db:migrate"
systemctl restart giftcard-api
sleep 2
curl -fsS http://127.0.0.1:4000/health && echo && echo "✓ updated"
