#!/usr/bin/env bash
# One-time move of the Flutter web app from https://gdkites.in/app/ to https://app.gdkites.in/.
#
#   Before: add a DNS A record  app.gdkites.in → this server's IP, and wait until it resolves.
#   Run:    sudo bash add-app-subdomain.sh
#
# What it does (safe to run twice):
#   1. nginx site for app.gdkites.in serving /var/www/gdkites/app (the same folder CI deploys to).
#      It also answers /app/... so the build that is live right now keeps working until CI
#      deploys the new one (built with --base-href /).
#   2. HTTPS for app.gdkites.in with certbot (HTTP is redirected to HTTPS).
#   3. gdkites.in/app/... redirects to app.gdkites.in/...  (old links and bookmarks keep working).
#   4. Adds https://app.gdkites.in to CORS_ORIGINS in /etc/gdkites/api.env and restarts the API.
# Any nginx error restores the previous config.
set -euo pipefail

APP_HOST=app.gdkites.in
APP_DIR=/var/www/gdkites/app
SITE=/etc/nginx/sites-available/gdkites
APP_SITE=/etc/nginx/sites-available/gdkites-app
ENV_FILE=/etc/gdkites/api.env

[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }

MY_IP=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
DNS_IP=$(getent ahostsv4 "$APP_HOST" | awk 'NR==1{print $1}' || true)
if [ "$DNS_IP" != "$MY_IP" ]; then
  echo "$APP_HOST resolves to '${DNS_IP:-nothing}', this server is $MY_IP." >&2
  echo "Add the DNS A record (or wait for it to spread), then run this again." >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
cp "$SITE" "$SITE.bak-$STAMP"
[ -f "$APP_SITE" ] && cp "$APP_SITE" "$APP_SITE.bak-$STAMP"
restore() {
  echo "nginx rejected the change; restoring the previous config." >&2
  cp "$SITE.bak-$STAMP" "$SITE"
  if [ -f "$APP_SITE.bak-$STAMP" ]; then cp "$APP_SITE.bak-$STAMP" "$APP_SITE"; else rm -f "$APP_SITE" /etc/nginx/sites-enabled/gdkites-app; fi
  nginx -t && systemctl reload nginx
  exit 1
}

# 1. The app's own site (HTTP first; certbot adds HTTPS below).
if [ ! -f "$APP_SITE" ]; then
  cat > "$APP_SITE" <<EOF
# GD Kites web app (Flutter web, built with --base-href /). HTTPS added by certbot.
server {
    listen 80;
    listen [::]:80;
    server_name $APP_HOST;

    root $APP_DIR;
    index index.html;
    charset utf-8;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_types text/plain text/css text/javascript application/javascript application/json
               application/manifest+json application/wasm image/svg+xml font/ttf font/otf;

    # Builds made for the old /app/ address still load here.
    location /app/ {
        alias $APP_DIR/;
        try_files \$uri \$uri/ /index.html;
        add_header Cache-Control "no-cache";
    }

    # Unknown paths are app routes.
    location / {
        try_files \$uri \$uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
}
EOF
  ln -sfn "$APP_SITE" /etc/nginx/sites-enabled/gdkites-app
  nginx -t || restore
  systemctl reload nginx
fi

# 2. HTTPS.
if ! grep -q "ssl_certificate" "$APP_SITE"; then
  certbot --nginx -d "$APP_HOST" --redirect --non-interactive --keep-until-expiring || restore
fi

# 3. Old address → new address (on gdkites.in, plain and HTTPS server blocks alike).
if ! grep -q "$APP_HOST" "$SITE"; then
  perl -0pi -e '
    s{[ \t]*location = /app \{.*?\}\n(?:[ \t]*\n)*}{}sg;
    s{location /app/ \{.*?\}}{location ^~ /app {\n        rewrite ^/app/?(.*)\$ https://'"$APP_HOST"'/\$1 permanent;\n    }}sg;
  ' "$SITE"
  nginx -t || restore
  systemctl reload nginx
fi

# 4. Let the app's new origin call the API.
CURRENT=$(sed -n 's/^CORS_ORIGINS=//p' "$ENV_FILE")
if [ -n "$CURRENT" ] && [ "$CURRENT" != "*" ] && ! printf '%s' "$CURRENT" | grep -q "https://$APP_HOST"; then
  cp "$ENV_FILE" "$ENV_FILE.bak-$STAMP"
  sed -i "s#^CORS_ORIGINS=.*#CORS_ORIGINS=$CURRENT,https://$APP_HOST#" "$ENV_FILE"
  systemctl restart gdkites-api
fi

echo
echo "Done."
curl -sS -o /dev/null -w "https://$APP_HOST/            → %{http_code}\n" "https://$APP_HOST/"
curl -sS -o /dev/null -w "https://gdkites.in/app/      → %{http_code} %{redirect_url}\n" "https://gdkites.in/app/"
echo "CORS_ORIGINS=$(sed -n 's/^CORS_ORIGINS=//p' "$ENV_FILE")"
