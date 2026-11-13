#!/usr/bin/env bash
# Get the newest server code, league list and Arabic names, then restart (keeps .env and the saved data). Run as root.
set -euo pipefail
RAW="https://raw.githubusercontent.com/maythm91mk-droid/jaguar-x-public/main/tools/matches-server"
APP=/opt/jaguar-matches
for f in server.js arabic.js devices.js tv.js fill.js leagues.json names.json; do curl -fsSL "$RAW/$f" -o "$APP/$f"; done
chown -R jaguar:jaguar "$APP"
systemctl restart jaguar-matches
sleep 2; systemctl --no-pager status jaguar-matches | head -5
# The channel reader (tv.js) starts 20 s after a restart: show what it got (12 Nov 2026).
sleep 45; journalctl -u jaguar-matches --since "-1min" --no-pager | grep -E " (tv|fill)[: ]" || echo "tv: no line yet"
