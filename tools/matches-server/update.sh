#!/usr/bin/env bash
# Get the newest server code and restart (keeps .env, names.json and the saved data). Run as root.
set -euo pipefail
RAW="https://raw.githubusercontent.com/maythm91mk-droid/jaguar-x-public/main/tools/matches-server"
APP=/opt/jaguar-matches
for f in server.js leagues.json; do curl -fsSL "$RAW/$f" -o "$APP/$f"; done
chown -R jaguar:jaguar "$APP"
systemctl restart jaguar-matches
sleep 2; systemctl --no-pager status jaguar-matches | head -5
