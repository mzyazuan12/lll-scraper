#!/usr/bin/env python3
"""Run the temporary queue cleanup bot (pause the 12 scrapers first)."""

import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))

env = os.environ.copy()
env.setdefault("DRY_RUN", "0")
env.setdefault("STATE_FROM", "0")
env.setdefault("STATE_TO", "11")
env.setdefault("TARGET_URL", "https://lastletterlibrary.com")
env.setdefault("PROXY_MODE", "tor")
env.setdefault("MIN_GAP_MS", "15200")

log = open("cleanup-queue.log", "a", buffering=1)
proc = subprocess.Popen(
    ["node", "cleanup-queue.mjs"],
    env=env,
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=log,
    start_new_session=True,
    close_fds=True,
)
print(
    f"cleanup pid={proc.pid} DRY_RUN={env['DRY_RUN']} "
    f"states={env['STATE_FROM']}..{env['STATE_TO']} → cleanup-queue.log"
)
sys.exit(0)
