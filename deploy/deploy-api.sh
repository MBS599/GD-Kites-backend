#!/usr/bin/env bash
# Installs a new API release on the server (run as root):
#   sudo bash deploy-api.sh /tmp/gdkites-api.tar.gz
# The archive comes from `git archive` of the backend repo. Uploaded files and the
# WhatsApp login live in /srv/gdkites/data and are never touched by a deploy.
set -euo pipefail
ARCHIVE=${1:?usage: deploy-api.sh <archive.tar.gz>}
API=/srv/gdkites/api

systemctl stop gdkites-api || true
find "$API" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -xzf "$ARCHIVE" -C "$API"
ln -sfn /srv/gdkites/data/uploads "$API/uploads"
chown -R gdkites:gdkites "$API"

sudo -u gdkites -H bash -c "
  set -euo pipefail
  set -a; . /etc/gdkites/api.env; set +a
  cd $API
  npm ci --no-audit --no-fund
  npx prisma generate
  npm run build
  npx prisma migrate deploy
"
systemctl start gdkites-api
sleep 3
systemctl --no-pager --lines=0 status gdkites-api | head -3
