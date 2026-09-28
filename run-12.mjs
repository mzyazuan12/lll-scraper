import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const TARGET_URL =
  process.env.TARGET_URL ?? "https://lastletterlibrary.com";

const COOLDOWN_MS = process.env.COOLDOWN_MS ?? "0";

/*
 * 12 agents — each owns ~2 root letters and recurses letter-first.
 * Supervisor keeps all 12 alive forever:
 *   - respawn on exit
 *   - respawn if log goes silent (wedged Turnstile / hung Chrome)
 */
const WORKERS = [
  "ab",
  "cd",
  "ef",
  "gh",
  "ij",
  "kl",
  "mn",
  "op",
  "qr",
  "st",
  "uv",
  "wxyz"
];

const RESET = process.env.RESET === "1";
const STAGGER_MS = Number(process.env.STAGGER_MS ?? "4000");
const PROXY_MODE = process.env.PROXY_MODE ?? "tor";
const PROXY_LIST = process.env.PROXY_LIST ?? "proxies.txt";
const RESTART_DELAY_MS = Number(process.env.RESTART_DELAY_MS ?? "8000");
const STALE_LOG_MS = Number(process.env.STALE_LOG_MS ?? String(6 * 60_000));
const HEALTH_EVERY_MS = Number(process.env.HEALTH_EVERY_MS ?? "60000");
// ~15s/IP matches the live API window; adaptive learns if server asks longer.
const MIN_GAP_MS = process.env.MIN_GAP_MS ?? "15500";

const children = new Map(); // workerId -> { child, letters, logPath, starting, completed }
const recentExits = new Map(); // workerId -> [timestamps of last 5 min]

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function resetOutputs() {
  const dir = process.cwd();
  const entries = await fs.readdir(dir);

  for (const name of entries) {
    if (
      name === "last.txt" ||
      /^last-\d+\.txt$/.test(name) ||
      /^lll-audit-state.*\.json$/.test(name) ||
      /^failure-.*\.png$/.test(name) ||
      /^worker-\d+\.log$/.test(name)
    ) {
      await fs.unlink(path.join(dir, name)).catch(() => {});
    }
  }

  await fs.writeFile("last.txt", "", "utf8");
  for (let i = 0; i < WORKERS.length; i++) {
    await fs.writeFile(`last-${i}.txt`, "", "utf8");
  }
  console.log("Reset last.txt, last-*.txt, worker logs, and state files");
}

async function wipeChromeProfiles() {
  const { execSync } = await import("node:child_process");
  for (let i = 0; i < WORKERS.length; i++) {
    await fs
      .rm(`/tmp/lll-pw-w${i}`, { recursive: true, force: true })
      .catch(() => {});
    try {
      execSync(`rm -rf /tmp/lll-pw-w${i}-r* /tmp/lll-tor-w${i}`, {
        stdio: "ignore"
      });
    } catch {
      // ignore
    }
  }
  console.log("Wiped Chrome/Tor profiles under /tmp/lll-pw-w* /tmp/lll-tor-w*");
}

async function startWorker(i, { appendLog = false } = {}) {
  const existing = children.get(i);
  if (existing?.completed) {
    return;
  }
  if (existing?.starting) {
    return;
  }
  if (existing?.child && existing.child.exitCode == null) {
    return;
  }

  const letters = WORKERS[i];
  const profileDir = `/tmp/lll-pw-w${i}`;
  const logPath = path.resolve(`worker-${i}.log`);

  // If this worker has exited repeatedly in the last 5 minutes, wipe its
  // Chrome/Turnstile profile before respawn. A corrupted profile can cause
  // the same mint/403 failure loop on every restart, wasting time.
  if (appendLog) {
    const now = Date.now();
    const exits = (recentExits.get(i) || []).filter(
      t => now - t < 5 * 60 * 1000
    );
    if (exits.length >= 2) {
      await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
      console.log(
        `Wiped profile for w${i} (${letters}) after ${exits.length} recent exits`
      );
    }
  }

  await fs.mkdir(profileDir, { recursive: true });

  children.set(i, {
    child: null,
    letters,
    logPath,
    starting: true,
    startedAt: Date.now(),
    completed: false
  });

  // Worker logs are operational history; never truncate them on supervisor
  // restart. State is resumed, so the matching evidence should be preserved.
  const logFile = await fs.open(logPath, "a");
  if (appendLog) {
    await logFile.write(
      `\n--- respawn ${new Date().toISOString()} ---\n`
    );
  }

  const child = spawn("node", ["audit.mjs"], {
    env: {
      ...process.env,
      TARGET_URL,
      COOLDOWN_MS,
      PROXY_MODE,
      PROXY_LIST,
      LIBRARY_MODE: process.env.LIBRARY_MODE ?? "pro",
      MIN_GAP_MS,
      SEARCH_MODE: process.env.SEARCH_MODE ?? "direct",
      FAST_MODE: process.env.FAST_MODE ?? "1",
      WORKER_ID: String(i),
      LETTERS: letters,
      PROFILE_DIR: profileDir,
      CDP_URL: ""
    },
    stdio: ["ignore", logFile.fd, logFile.fd],
    detached: false
  });

  children.set(i, {
    child,
    letters,
    logPath,
    starting: false,
    startedAt: Date.now(),
    completed: false
  });

  child.on("exit", code => {
    logFile.close().catch(() => {});
    console.log(
      `Audit w${i} (${letters}) exited with code ${code}`
    );
    const cur = children.get(i);
    if (cur?.child === child) {
      children.set(i, {
        child: null,
        letters,
        logPath,
        starting: false,
        startedAt: cur.startedAt,
        completed: code === 0
      });
    }

    // A clean exit means this worker's persisted queue is complete. Leaving
    // it stopped avoids an endless Tor/Chrome respawn loop for finished work.
    if (code === 0) {
      console.log(`Audit w${i} (${letters}) complete — not respawning`);
      return;
    }

    // Record exit time for rapid-respawn detection and backoff.
    const now = Date.now();
    const exits = (recentExits.get(i) || []).filter(
      t => now - t < 5 * 60 * 1000
    );
    exits.push(now);
    recentExits.set(i, exits);
    const rapidCount = exits.length;

    // Exponential backoff when a worker is crash-looping: 8s, 16s, 32s, 64s, 120s max.
    const delay = Math.min(
      RESTART_DELAY_MS * Math.pow(2, Math.max(0, rapidCount - 1)),
      120_000
    );

    setTimeout(() => {
      console.log(
        `Respawning Audit w${i} (${letters}) after exit (delay ${delay}ms)`
      );
      startWorker(i, { appendLog: true }).catch(error => {
        console.error(`Failed to respawn w${i}:`, error);
      });
    }, delay);
  });

  console.log(
    `Audit w${i} pid=${child.pid} letters=${letters} ` +
      `proxy=${PROXY_MODE} → worker-${i}.log` +
      (appendLog ? " (respawn)" : "")
  );
}

async function killWorker(i, reason) {
  const entry = children.get(i);
  if (!entry?.child || entry.child.exitCode != null) {
    return;
  }
  console.log(
    `Killing wedged Audit w${i} (${entry.letters}) — ${reason}`
  );
  try {
    entry.child.kill("SIGTERM");
  } catch {
    // ignore
  }
  await sleep(1500);
  try {
    if (entry.child.exitCode == null) {
      entry.child.kill("SIGKILL");
    }
  } catch {
    // ignore
  }
}

async function queueRemaining(i) {
  try {
    const raw = await fs.readFile(`lll-audit-state-${i}.json`, "utf8");
    const state = JSON.parse(raw);
    return Array.isArray(state.queue) ? state.queue.length : 0;
  } catch {
    return 0;
  }
}

async function healthSweep() {
  const now = Date.now();
  let alive = 0;
  let completed = 0;

  for (let i = 0; i < WORKERS.length; i++) {
    const entry = children.get(i);
    if (entry?.completed) {
      // Re-activate workers that finished their original letters but were
      // later given leftover queue (e.g. p-slices split from W7).
      const remaining = await queueRemaining(i);
      if (remaining > 0) {
        console.log(
          `Health: w${i} (${WORKERS[i]}) marked complete but queue=${remaining} — reactivating`
        );
        children.set(i, {
          child: null,
          letters: WORKERS[i],
          logPath: path.resolve(`worker-${i}.log`),
          starting: false,
          startedAt: Date.now(),
          completed: false
        });
        await startWorker(i, { appendLog: true }).catch(error => {
          console.error(`Health reactivate w${i} failed:`, error);
        });
        continue;
      }
      completed += 1;
      continue;
    }
    const running =
      entry?.child &&
      entry.child.exitCode == null &&
      !entry.starting;

    if (running) {
      alive += 1;
      try {
        const stat = await fs.stat(entry.logPath);
        const age = now - stat.mtimeMs;
        const uptime = now - (entry.startedAt || now);
        // Give brand-new workers time to bootstrap Tor + Turnstile.
        if (uptime > 4 * 60_000 && age > STALE_LOG_MS) {
          await killWorker(
            i,
            `log stale ${Math.round(age / 1000)}s`
          );
        }
      } catch {
        // missing log — kill so respawn recreates it
        await killWorker(i, "missing log file");
      }
    } else if (!entry?.starting) {
      console.log(
        `Health: w${i} (${WORKERS[i]}) not running — spawning`
      );
      await startWorker(i, { appendLog: true }).catch(error => {
        console.error(`Health spawn w${i} failed:`, error);
      });
    }
  }

  console.log(
    `Health: ${alive} active, ${completed} complete, ` +
      `${WORKERS.length - alive - completed} restarting`
  );
}

async function main() {
  if (RESET) {
    await resetOutputs();
    await wipeChromeProfiles();
  }

  // Fresh exit-IP claims so resumed workers don't inherit stale collisions.
  await fs.unlink("/tmp/lll-exit-ips.json").catch(() => {});
  await fs.unlink("/tmp/lll-exit-ips.json.lock").catch(() => {});

  console.log(
    [
      `Starting ${WORKERS.length} recursive scrapers against ${TARGET_URL}`,
      `PROXY_MODE=${PROXY_MODE}`,
      `LIBRARY_MODE=${process.env.LIBRARY_MODE ?? "pro"} (activeMode on /api/words/game)`,
      `SEARCH_MODE=${process.env.SEARCH_MODE ?? "direct"} FAST_MODE=${process.env.FAST_MODE ?? "1"}`,
      `MIN_GAP_MS=${MIN_GAP_MS}`,
      "Hardened: auto-respawn on crash, kill+respawn on stale logs,",
      "Tor rotate on BANNED_IP/Turnstile/timeout, exit-IP dedup, never drop prefixes.",
      `Stagger=${STAGGER_MS}ms cooldown=${COOLDOWN_MS}ms stale=${STALE_LOG_MS}ms`
    ].join("\n")
  );

  for (let i = 0; i < WORKERS.length; i++) {
    await startWorker(i);
    if (i < WORKERS.length - 1) {
      await sleep(STAGGER_MS);
    }
  }

  console.log(
    [
      "",
      "All workers launched. Supervisor watching forever.",
      "Merged words: last.txt",
      "Stop: pkill -f 'node audit.mjs'; pkill -f 'node run-12.mjs'"
    ].join("\n")
  );

  setInterval(() => {
    healthSweep().catch(error => {
      console.error("healthSweep error:", error);
    });
  }, HEALTH_EVERY_MS);

  await new Promise(() => {});
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
