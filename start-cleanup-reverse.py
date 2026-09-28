#!/usr/bin/env python3
"""Run reverse (Z→A) queue cleanup across all 12 state files.
Pause the main scrapers first — they race on the same JSON.
"""

import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))

env = os.environ.copy()
env.setdefault("DRY_RUN", "0")
env.setdefault("STAGGER_MS", "3500")
env.setdefault("TARGET_URL", "https://lastletterlibrary.com")
env.setdefault("PROXY_MODE", "tor")
env.setdefault("MIN_GAP_MS", "15500")
# 3-letter parents / 4+ children by default; override for deeper passes:
#   PARENT_MIN_LEN=4 CHILD_MIN_LEN=5 python3 start-cleanup-reverse.py
env.setdefault("PARENT_MIN_LEN", "3")
env.setdefault("CHILD_MIN_LEN", "4")

parent_len = env["PARENT_MIN_LEN"]
child_len = env["CHILD_MIN_LEN"]
log_name = (
    "cleanup-reverse-supervisor.log"
    if parent_len == "3"
    else f"cleanup-reverse-p{parent_len}-supervisor.log"
)

log = open(log_name, "a", buffering=1)
proc = subprocess.Popen(
    ["node", "run-cleanup-reverse-12.mjs"],
    env=env,
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=log,
    start_new_session=True,
    close_fds=True,
)
print(
    f"cleanup-reverse supervisor pid={proc.pid} DRY_RUN={env['DRY_RUN']} "
    f"parents={parent_len}-letter children>={child_len} "
    f"→ {log_name} / cleanup-rev-*.log"
)
sys.exit(0)
