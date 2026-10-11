#!/usr/bin/env bash
# Installs a new API release on the server (run as root):
#   sudo bash deploy-api.sh /tmp/gdkites-api.tar.gz
# The archive comes from `git archive` of the backend repo. Uploaded files and the
# WhatsApp login live in /srv/gdkites/data and are never touched by a deploy.
#
# Near-zero downtime: the release is installed and built in api.next while the
# current API keeps serving; migrations are additive, so they run before the
# switch. Only the swap + restart (a few seconds) interrupts requests. If the new
# release doesn't answer its health check, the previous one is put back.
set -euo pipefail
ARCHIVE=${1:?usage: deploy-api.sh <archive.tar.gz>}
API=/srv/gdkites/api
NEXT=/srv/gdkites/api.next
PREV=/srv/gdkites/api.prev

rm -rf "$NEXT"
mkdir -p "$NEXT"
tar -xzf "$ARCHIVE" -C "$NEXT"
# The archive has its own empty uploads/ folder: replace it with the persistent one.
rm -rf "$NEXT/uploads"
ln -sfn /srv/gdkites/data/uploads "$NEXT/uploads"
chown -R gdkites:gdkites "$NEXT"

sudo -u gdkites -H bash -c "
  set -euo pipefail
  set -a; . /etc/gdkites/api.env; set +a
  cd $NEXT
  npm ci --include=dev --no-audit --no-fund   # build + migrations need the dev tools
  npx prisma generate
  npm run build
  npx prisma migrate deploy
"

healthy() {
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:${PORT:-3000}/api/v1/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# Swap and restart.
systemctl stop gdkites-api || true
rm -rf "$PREV"
[ -d "$API" ] && mv "$API" "$PREV"
mv "$NEXT" "$API"
systemctl start gdkites-api

set -a; . /etc/gdkites/api.env; set +a
if ! healthy; then
  echo "New release did not become healthy: restoring the previous one" >&2
  systemctl stop gdkites-api || true
  if [ -d "$PREV" ]; then
    rm -rf "$API.failed"; mv "$API" "$API.failed"; mv "$PREV" "$API"
    systemctl start gdkites-api
  fi
  exit 1
fi
systemctl --no-pager --lines=0 status gdkites-api | head -3
