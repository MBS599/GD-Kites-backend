#!/usr/bin/env bash
# Writes the Google web client ID (first entry of GOOGLE_CLIENT_ID in /etc/gdkites/api.env)
# into the web app's index.html. Run after uploading a web build or changing the ID:
#   sudo bash set-web-client-id.sh
set -euo pipefail
ID=$(sed -n 's/^GOOGLE_CLIENT_ID=//p' /etc/gdkites/api.env | cut -d, -f1)
[ -n "$ID" ] || { echo "GOOGLE_CLIENT_ID is empty in /etc/gdkites/api.env" >&2; exit 1; }
sed -i -E "s#(name=\"google-signin-client_id\" content=\")[^\"]*#\1$ID#" /var/www/gdkites/app/index.html
grep -o 'google-signin-client_id" content="[^"]*' /var/www/gdkites/app/index.html
