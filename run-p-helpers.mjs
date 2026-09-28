/**
 * Keep W4/W5/W8/W11 alive while they chew through the p-queue slices
 * split off from W7. Supervisor ignores them (marked complete), so this
 * process owns respawn until each helper's state queue is empty.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const HELPERS = [
  { id: 4, letters: "ij" },
  { id: 5, letters: "kl" },
  { id: 8, letters: "qr" },
  { id: 11, letters: "wxyz" }
];

const TARGET_URL =
  process.env.TARGET_URL ?? "https://lastletterlibrary.com";
// Every helper uses a dedicated Tor SOCKS/control pair. audit.mjs keeps each
// Tor daemon alive and rotates circuits with NEWNYM instead of rebootstrap.
const PROXY_MODE = process.env.PROXY_MODE ?? "tor";
const PROXY_LIST = process.env.PROXY_LIST ?? "proxies.txt";
const MIN_GAP_MS = process.env.MIN_GAP_MS ?? "15500";
const RESTART_DELAY_MS = Number(process.env.RESTART_DELAY_MS ?? "12000");
const HEALTH_EVERY_MS = Number(process.env.HEALTH_EVERY_MS ?? "30000");
const STAGGER_MS = Number(process.env.STAGGER_MS ?? "15000");

const children = new Map();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function queueLen(id) {
  try {
    const raw = await fs.readFile(`lll-audit-state-${id}.json`, "utf8");
    const state = JSON.parse(raw);
    return Array.isArray(state.queue) ? state.queue.length : 0;
  } catch {
    return -1;
  }
}

async function startHelper(id, letters, { appendLog = false } = {}) {
  const existing = children.get(id);
  if (existing?.starting) return;
  if (existing?.child && existing.child.exitCode == null) return;

  const q = await queueLen(id);
  if (q === 0) {
    console.log(`Helper w${id} queue empty — not starting`);
    children.set(id, {
      child: null,
      letters,
      completed: true,
      starting: false,
      startedAt: Date.now()
    });
    return;
  }

  const profileDir = `/tmp/lll-pw-w${id}`;
  const logPath = path.resolve(`worker-${id}.log`);
  await fs.mkdir(profileDir, { recursive: true });

  children.set(id, {
    child: null,
    letters,
    logPath,
    starting: true,
    completed: false,
    startedAt: Date.now()
  });

  const logFile = await fs.open(logPath, "a");
  await logFile.write(
    `\n--- p-helper ${appendLog ? "respawn" : "start"} ${new Date().toISOString()} queue=${q} ---\n`
  );

  const child = spawn("node", ["audit.mjs"], {
    env: {
      ...process.env,
      TARGET_URL,
      COOLDOWN_MS: process.env.COOLDOWN_MS ?? "0",
      PROXY_MODE,
      PROXY_LIST,
      LIBRARY_MODE: process.env.LIBRARY_MODE ?? "pro",
      MIN_GAP_MS,
      SEARCH_MODE: process.env.SEARCH_MODE ?? "direct",
      FAST_MODE: process.env.FAST_MODE ?? "1",
      WORKER_ID: String(id),
      LETTERS: letters,
      PROFILE_DIR: profileDir,
      CDP_URL: ""
    },
    stdio: ["ignore", logFile.fd, logFile.fd]
  });

  children.set(id, {
    child,
    letters,
    logPath,
    starting: false,
    completed: false,
    startedAt: Date.now()
  });

  child.on("exit", code => {
    logFile.close().catch(() => {});
    console.log(`Helper w${id} (${letters}) exited code=${code}`);
    const cur = children.get(id);
    if (cur?.child === child) {
      children.set(id, {
        child: null,
        letters,
        logPath,
        starting: false,
        completed: false,
        startedAt: cur.startedAt
      });
    }

    setTimeout(() => {
      startHelper(id, letters, { appendLog: true }).catch(err => {
        console.error(`Failed to respawn helper w${id}:`, err);
      });
    }, RESTART_DELAY_MS);
  });

  console.log(
    `Helper w${id} pid=${child.pid} letters=${letters} queue=${q} → worker-${id}.log`
  );
}

async function health() {
  let alive = 0;
  let done = 0;
  for (const { id, letters } of HELPERS) {
    const q = await queueLen(id);
    const entry = children.get(id);
    const running = entry?.child && entry.child.exitCode == null && !entry.starting;
    if (q === 0) {
      done += 1;
      if (running) {
        // Let it finish naturally; next exit won't respawn once queue empty
      }
      continue;
    }
    if (running) {
      alive += 1;
    } else if (!entry?.starting) {
      console.log(`Health: helper w${id} down with queue=${q} — spawning`);
      await startHelper(id, letters, { appendLog: true });
    }
  }
  console.log(`P-helpers health: ${alive} active, ${done} drained, assisting W7`);

  if (done === HELPERS.length) {
    console.log("All p-helper queues drained — exiting helper supervisor");
    process.exit(0);
  }
}

async function main() {
  console.log(
    `Starting ${HELPERS.length} p-queue helpers for W7 (PROXY_MODE=${PROXY_MODE})`
  );
  for (const { id, letters } of HELPERS) {
    await startHelper(id, letters);
    await sleep(STAGGER_MS);
  }
  setInterval(() => {
    health().catch(err => console.error("health error:", err));
  }, HEALTH_EVERY_MS);
  await new Promise(() => {});
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
