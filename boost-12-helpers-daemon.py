#!/usr/bin/env python3
"""Bounded keeper for every remaining audit worker."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

DIR = Path(__file__).resolve().parent
HELPERS = [
    (1, "cd"),
    (12, "cd"),
    (13, "cd"),
    (14, "cd"),
    (18, "st"),
    (19, "st"),
    (20, "st"),
    (21, "cd"),
    (22, "cd"),
    (23, "st"),
    (24, "st"),
    (25, "st"),
    # Extra CD helpers (2-way split of remaining parents).
    (26, "cd"),
    (27, "cd"),
    (28, "cd"),
    (29, "cd"),
    (30, "cd"),
    (31, "cd"),
]
LOG = DIR / "boost-12-helpers-daemon.log"
PIDFILE = DIR / "boost-12-helpers-daemon.pid"
STAGGER_S = 8
POLL_S = 25
# 6 parents + 6 extra helpers once remaining CD queues are split.
MAX_HELPERS = max(1, int(os.environ.get("MAX_HELPERS", "12")))


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}\n"
    with LOG.open("a") as f:
        f.write(line)
        f.flush()


def queue_len(wid: int) -> int:
    try:
        data = json.loads((DIR / f"lll-audit-state-{wid}.json").read_text())
        return len(data.get("queue") or [])
    except Exception:
        return -1


def live_worker_ids() -> set[str]:
    out = subprocess.check_output(["ps", "aux"], text=True)
    live: set[str] = set()
    for line in out.splitlines():
        if "node audit.mjs" not in line:
            continue
        pid = line.split()[1]
        try:
            env = subprocess.check_output(["ps", "eww", "-p", pid], text=True)
        except subprocess.CalledProcessError:
            continue
        for tok in env.replace("\n", " ").split():
            if tok.startswith("WORKER_ID="):
                live.add(tok.split("=", 1)[1])
                break
    return live


def start_helper(wid: int, letters: str) -> None:
    q = queue_len(wid)
    if q <= 0:
        log(f"w{wid} queue empty — skip")
        return
    profile = f"/tmp/lll-pw-w{wid}"
    os.makedirs(profile, exist_ok=True)
    try:
        os.unlink(f"/tmp/lll-audit-w{wid}.lock")
    except FileNotFoundError:
        pass
    log_path = DIR / f"worker-{wid}.log"
    with log_path.open("a") as lf:
        lf.write(
            f"\n--- boost-12 daemon start "
            f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} "
            f"queue={q} ---\n"
        )
    env = os.environ.copy()
    env.update(
        {
            "TARGET_URL": "https://lastletterlibrary.com",
            "COOLDOWN_MS": "0",
            "PROXY_MODE": os.environ.get("PROXY_MODE", "tor"),
            "PROXY_LIST": "proxies.txt",
            "LIBRARY_MODE": "pro",
            "MIN_GAP_MS": "15500",
            "SEARCH_MODE": "direct",
            "FAST_MODE": "1",
            "WORKER_ID": str(wid),
            "LETTERS": letters,
            "PROFILE_DIR": profile,
            "CDP_URL": "",
            "RESET": "0",
        }
    )
    logf = open(log_path, "a")
    proc = subprocess.Popen(
        ["node", "audit.mjs"],
        cwd=str(DIR),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=logf,
        stderr=logf,
        start_new_session=True,
    )
    logf.close()
    log(f"started w{wid} pid={proc.pid} letters={letters} queue={q}")


def daemon_main() -> None:
    PIDFILE.write_text(str(os.getpid()))
    log(f"daemon up pid={os.getpid()} max_helpers={MAX_HELPERS}")
    while True:
        try:
            live = live_worker_ids()
            active_helpers = [
                wid for wid, _ in HELPERS if str(wid) in live
            ]
            pending = []
            for wid, letters in HELPERS:
                q = queue_len(wid)
                if q <= 0:
                    continue
                if str(wid) in live:
                    continue
                pending.append((wid, letters, q))
            if not pending and all(queue_len(w) <= 0 for w, _ in HELPERS):
                log("all helper queues drained — daemon exiting")
                try:
                    PIDFILE.unlink()
                except FileNotFoundError:
                    pass
                return
            # Finish the shortest queues first and keep enough memory free for
            # Chrome/Turnstile work.
            pending.sort(key=lambda item: (item[2], item[0]))
            slots = max(0, MAX_HELPERS - len(active_helpers))
            for wid, letters, q in pending[:slots]:
                log(f"w{wid} down with queue={q} — spawning")
                start_helper(wid, letters)
                time.sleep(STAGGER_S)
            alive = [w for w, _ in HELPERS if str(w) in live_worker_ids()]
            drained = [w for w, _ in HELPERS if queue_len(w) <= 0]
            log(
                f"health alive={alive} drained={drained}"
            )
        except Exception as exc:
            log(f"loop error: {exc!r}")
        time.sleep(POLL_S)


def already_running() -> bool:
    if not PIDFILE.exists():
        return False
    try:
        pid = int(PIDFILE.read_text().strip())
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def detach_and_run() -> None:
    if already_running():
        print("daemon already running", file=sys.stderr)
        sys.exit(0)
    if os.fork() > 0:
        sys.exit(0)
    os.setsid()
    if os.fork() > 0:
        sys.exit(0)
    os.chdir(DIR)
    sys.stdin.close()
    logf = open(LOG, "a", buffering=1)
    os.dup2(logf.fileno(), 1)
    os.dup2(logf.fileno(), 2)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    daemon_main()


if __name__ == "__main__":
    detach_and_run()
