#!/usr/bin/env bash
# Jaguar X match server: one-time setup on a fresh Ubuntu 24.04 VPS. Run as root:
#   curl -fsSL https://raw.githubusercontent.com/maythm91mk-droid/jaguar-x-public/main/tools/matches-server/setup.sh | bash
# Safe to run again (keeps .env and the saved data).
set -euo pipefail
DOMAIN="${DOMAIN:-api.jaguarxiq.com}"
RAW="https://raw.githubusercontent.com/maythm91mk-droid/jaguar-x-public/main/tools/matches-server"
APP=/opt/jaguar-matches

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "شغّله كـ root"; exit 1; }

say "تحديث النظام"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get upgrade -y
apt-get install -y curl ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https openssl

say "جدار الحماية: بس SSH و 80 و 443"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable

say "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

say "Caddy (يسوي HTTPS وحده)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

say "ملفات الخدمة"
id jaguar >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin jaguar
mkdir -p "$APP/data"
for f in server.js leagues.json; do curl -fsSL "$RAW/$f" -o "$APP/$f"; done
# names.json is downloaded only the first time (later you may add names on the server).
[ -f "$APP/names.json" ] || curl -fsSL "$RAW/names.json" -o "$APP/names.json"

if [ ! -f "$APP/.env" ]; then
  say "مفتاح API-Football"
  echo "الصق المفتاح من https://dashboard.api-football.com (صفحة Account / My Access) واضغط Enter (ما راح يبين وانت تلصقه):"
  read -rs KEY </dev/tty
  KEY=$(printf %s "$KEY" | tr -cd "a-zA-Z0-9")
  [ -n "$KEY" ] || { echo "ما لصقت شي"; exit 1; }
  cat > "$APP/.env" <<ENV
API_KEY=$KEY
APP_SECRET=$(openssl rand -hex 24)
STATUS_KEY=$(openssl rand -hex 12)
DAILY_LIMIT=100
LIVE_EVERY_MIN=6
PORT=8080
ENV
fi
chown -R jaguar:jaguar "$APP"
chmod 600 "$APP/.env"

say "تشغيل الخدمة (ترجع تشتغل وحدها بعد أي إعادة تشغيل)"
cat > /etc/systemd/system/jaguar-matches.service <<UNIT
[Unit]
Description=Jaguar X match server
After=network-online.target
Wants=network-online.target

[Service]
User=jaguar
WorkingDirectory=$APP
ExecStart=/usr/bin/node $APP/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now jaguar-matches
systemctl restart jaguar-matches

say "Caddy على $DOMAIN"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    encode gzip
    reverse_proxy 127.0.0.1:8080
}
CADDY
systemctl reload caddy || systemctl restart caddy

IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
STATUS=$(grep ^STATUS_KEY "$APP/.env" | cut -d= -f2)
say "خلص ✅"
echo "رقم السيرفر (IP): $IP"
echo "صفحة العداد:     https://$DOMAIN/status?key=$STATUS"
echo "الأسماء الناقصة: https://$DOMAIN/missing?key=$STATUS"
echo
echo "فحص تغطية الدوري العراقي (طلب واحد):"
echo "  cd $APP && sudo -u jaguar node server.js --coverage"
echo
echo "السر مال التطبيق (APP_SECRET) بالملف $APP/.env — ينحط بـ GitHub Secrets باسم JX_MATCHES_SECRET، لا تدزه بالشات."
