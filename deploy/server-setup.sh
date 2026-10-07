#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for GD Kites. Safe to re-run.
#   sudo bash deploy/server-setup.sh
# Installs nginx, PostgreSQL, Node.js 22 and the WhatsApp browser's libraries, creates
# the database and /etc/gdkites/api.env (secrets generated here, never leave the server).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

APP_USER=gdkites
APP_DIR=/srv/gdkites
WEB_DIR=/var/www/gdkites
ENV_FILE=/etc/gdkites/api.env

# 2 GB swap: the 1 GB plan needs headroom for the WhatsApp browser and builds.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/99-gdkites.conf
sysctl -q -p /etc/sysctl.d/99-gdkites.conf
timedatectl set-timezone Asia/Kolkata

apt-get update -q
apt-get -yq -o Dpkg::Options::=--force-confold upgrade
apt-get install -yq ca-certificates curl gnupg openssl nginx certbot python3-certbot-nginx \
  postgresql postgresql-contrib fail2ban unattended-upgrades \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 \
  libcairo2 libxshmfence1 fonts-liberation

if ! command -v node >/dev/null || ! node -v | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

id "$APP_USER" >/dev/null 2>&1 ||
  useradd --system --create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/api" "$APP_DIR/data/uploads" "$APP_DIR/data/wwebjs"
install -d -o ubuntu -g www-data "$WEB_DIR/website" "$WEB_DIR/app"
install -d -m 750 -o root -g "$APP_USER" /etc/gdkites

# PostgreSQL sized for a 1 GB server.
PG_CONF_DIR=$(ls -d /etc/postgresql/*/main/conf.d | head -1)
cat > "$PG_CONF_DIR/gdkites.conf" <<'EOF'
max_connections = 30
shared_buffers = 64MB
effective_cache_size = 256MB
work_mem = 2MB
maintenance_work_mem = 32MB
EOF
systemctl restart postgresql

if [ ! -f "$ENV_FILE" ]; then
  DB_PW=$(openssl rand -hex 24)
  sudo -u postgres psql -qtc "SELECT 1 FROM pg_roles WHERE rolname='gdkite'" | grep -q 1 ||
    sudo -u postgres psql -qc "CREATE ROLE gdkite LOGIN PASSWORD '$DB_PW'"
  sudo -u postgres psql -qc "ALTER ROLE gdkite PASSWORD '$DB_PW'"
  sudo -u postgres psql -qtc "SELECT 1 FROM pg_database WHERE datname='gdkite'" | grep -q 1 ||
    sudo -u postgres createdb -O gdkite gdkite
  umask 027
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://gdkite:$DB_PW@localhost:5432/gdkite?schema=public
JWT_ACCESS_SECRET=$(openssl rand -hex 48)
JWT_REFRESH_SECRET=$(openssl rand -hex 48)
JWT_ACCESS_TTL=3d
JWT_REFRESH_TTL_DAYS=365
PUBLIC_BASE_URL=https://api.gdkites.in
CORS_ORIGINS=https://gdkites.in,https://www.gdkites.in,https://app.gdkites.in
GOOGLE_CLIENT_ID=
BOOTSTRAP_ADMIN_EMAILS=
MESSAGING_PROVIDER=wwebjs
WWEBJS_SESSION_DIR=$APP_DIR/data/wwebjs
WWEBJS_MIN_GAP_MS=3000
FIREBASE_SERVICE_ACCOUNT=
PAYMENTS_PROVIDER=none
EOF
  chown root:"$APP_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "Created $ENV_FILE — fill in GOOGLE_CLIENT_ID and BOOTSTRAP_ADMIN_EMAILS."
fi

install -m 644 "$(dirname "$0")/gdkites-api.service" /etc/systemd/system/gdkites-api.service
systemctl daemon-reload
systemctl enable gdkites-api >/dev/null

install -m 644 "$(dirname "$0")/nginx-gdkites.conf" /etc/nginx/sites-available/gdkites
ln -sfn /etc/nginx/sites-available/gdkites /etc/nginx/sites-enabled/gdkites
rm -f /etc/nginx/sites-enabled/default
nginx -t -q
systemctl reload nginx

systemctl enable --now fail2ban unattended-upgrades >/dev/null
echo "Server setup done."
