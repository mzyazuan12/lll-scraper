#!/usr/bin/env python3
"""Detach run-12.mjs so Cursor/shell cleanup cannot kill the scrape."""

import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))

env = os.environ.copy()
env.setdefault("RESET", "0")
env.setdefault("STAGGER_MS", "3500")
env.setdefault("MIN_GAP_MS", "15500")
env.setdefault("PROXY_MODE", "tor")
env.setdefault("LIBRARY_MODE", "pro")
env.setdefault("SEARCH_MODE", "direct")
env.setdefault("FAST_MODE", "1")

log = open("supervisor.log", "a", buffering=1)
proc = subprocess.Popen(
    ["node", "run-12.mjs"],
    env=env,
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=log,
    start_new_session=True,
    close_fds=True,
)
print(f"supervisor pid={proc.pid} (detached, RESET={env['RESET']})")
sys.exit(0)
