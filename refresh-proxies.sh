#!/bin/bash
# Refresh free proxies from ProxyScrape (updates ~every minute).
# Workers hot-reload proxies.txt on each IP rotation (≥60s apart).
set -euo pipefail
cd "$(dirname "$0")"
curl -fsSL \
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text' \
  -o /tmp/proxies-raw.txt
grep -E '^(socks5|https)://' /tmp/proxies-raw.txt | sort -u > /tmp/proxies-new.txt
# Merge with existing so workers keep recently-working exits.
cat proxies.txt /tmp/proxies-new.txt 2>/dev/null | sort -u > proxies.txt.tmp
mv proxies.txt.tmp proxies.txt
echo "proxies.txt now has $(wc -l < proxies.txt | tr -d ' ') SOCKS5/HTTPS entries"
