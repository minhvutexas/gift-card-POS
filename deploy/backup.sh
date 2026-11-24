#!/usr/bin/env bash
# Nightly database dump. install.sh puts this in /etc/cron.daily/giftcard-backup.
# Keeps 14 days. Copy /var/backups/giftcard somewhere off this server too!
set -euo pipefail
DIR=/var/backups/giftcard
mkdir -p "$DIR"
sudo -u postgres pg_dump -Fc giftcard > "$DIR/giftcard-$(date +%F).dump"
find "$DIR" -name 'giftcard-*.dump' -mtime +14 -delete
