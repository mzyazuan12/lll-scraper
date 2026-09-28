# lll-scraper

ahahahahahHAHAHAHAHAHAHAHAHAH
anyway 

# scrlibrary-scraper
do ts first if ur wanting to scrape first since my logs, json and txt files r here u can del them by:

cd scrlibrary-scraper

RESET=1 python3 start-daemon.py

then once it starts those files shud naturally be created and fill up

Prefix scrape of the Pro library. Twelve workers walk `a`–`z` against `/api/words/game`, save progress, and merge into `last.txt`.

Default target is `https://lastletterlibrary.com`. `RESET=0` resumes from the existing `lll-audit-state-*.json` files. `RESET=1` deletes those files and `last*.txt` and starts over.

## One-time setup

From this folder:

```bash
cd scrlibrary-scraper
npm install
npx playwright install chromium
brew install tor
```

`tor` must be on `PATH` or at `/opt/homebrew/bin/tor`. Each worker starts its own Tor process. You do not need the system Tor daemon running.

## Start the scrape (resume)

This is the normal start. It keeps existing words and state.

```bash
cd scrlibrary-scraper
python3 start-daemon.py
```

That detaches `node run-12.mjs`. Defaults:

| Setting | Value |
|---|---|
| `RESET` | `0` (resume) |
| `PROXY_MODE` | `tor` |
| `LIBRARY_MODE` | `pro` |
| `SEARCH_MODE` | `direct` |
| `MIN_GAP_MS` | `15500` |
| `STAGGER_MS` | `3500` |

Workers own these letter pairs: `ab cd ef gh ij kl mn op qr st uv wxyz`.

## Start over

Only do this if you want an empty word list. It deletes `last.txt`, `last-*.txt`, state files, and worker logs.

```bash
cd scrlibrary-scraper
RESET=1 python3 start-daemon.py
```

## Watch it

```bash
tail -f supervisor.log
tail -f worker-0.log
wc -l last.txt
```

`supervisor.log` is the 12-worker supervisor. `worker-N.log` is one letter pair. `last.txt` is the merged word list. `last-N.txt` is that worker’s own list. `lll-audit-state-N.json` is the queue, so a restart continues where that worker stopped.

A healthy line looks like a `200` for a prefix. `429` means that IP is inside the ~15s window. Turnstile or `403` lines mean that worker is rotating its Tor exit.

## Stop it

```bash
pkill -f 'node audit.mjs'
pkill -f 'node run-12.mjs'
pkill -f 'tor --SocksPort 127.0.0.1:19'
```

State files stay on disk, so the next `python3 start-daemon.py` resumes.

## One worker (smoke test)

Runs in the foreground and only owns the letters you pass. `a` is enough to see whether Tor, Chromium, and Turnstile are working.

```bash
cd scrlibrary-scraper
TARGET_URL=https://lastletterlibrary.com \
PROXY_MODE=tor \
LIBRARY_MODE=pro \
SEARCH_MODE=direct \
WORKER_ID=99 \
LETTERS=a \
node audit.mjs
```

Stop it with Ctrl+C. It writes `last-99.txt` and `lll-audit-state-99.json`. Delete those if you do not want them mixed into a later full run.

## Without Tor

Home IP, one request about every 15 seconds:

```bash
PROXY_MODE=off python3 start-daemon.py
```

Or a proxy list. Refresh it, then start in list mode:

```bash
bash refresh-proxies.sh
PROXY_MODE=list python3 start-daemon.py
```

`proxies.txt` is `socks5://` or `https://` lines, one per line.

## What finished looks like

A worker exits `0` when its letter queue is empty and is not restarted. The supervisor stays up until the other workers finish. `last.txt` is the copy to keep.
