import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const WORKERS = 12;
const STAGGER_MS = Number(process.env.STAGGER_MS ?? "4000");
const DRY_RUN = process.env.DRY_RUN ?? "0";
const MERGE_EVERY_MS = Number(process.env.MERGE_EVERY_MS ?? "120000");
const PARENT_MIN_LEN = process.env.PARENT_MIN_LEN ?? "3";
const CHILD_MIN_LEN = process.env.CHILD_MIN_LEN ?? "4";
const LOG_PREFIX =
  process.env.CLEANUP_LOG_PREFIX ??
  (PARENT_MIN_LEN === "3" ? "cleanup-rev" : `cleanup-rev-p${PARENT_MIN_LEN}`);

const children = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function mergeOnce() {
  const { mergeSharedOutput } = await import("./audit.mjs");
  const total = await mergeSharedOutput();
  console.log(`Merged last.txt → ${total.toLocaleString()} words`);
}

async function startCleanupWorker(i, { appendLog = false } = {}) {
  const existing = children.get(i);
  if (existing?.child && existing.child.exitCode == null) {
    return;
  }

  const logPath = `${LOG_PREFIX}-${i}.log`;
  const logFile = await fs.open(logPath, appendLog ? "a" : "w");
  if (appendLog) {
    await logFile.write(`\n--- respawn ${new Date().toISOString()} ---\n`);
  }

  const child = spawn("node", ["cleanup-queue-reverse.mjs"], {
    env: {
      ...process.env,
      CLEANUP_ID: String(i),
      STATE_INDEX: String(i),
      STATE_FROM: String(i),
      STATE_TO: String(i),
      DRY_RUN,
      PARENT_MIN_LEN,
      CHILD_MIN_LEN,
      PROFILE_DIR: `/tmp/lll-pw-${LOG_PREFIX}-w${i}`,
      TOR_BASE_PORT: PARENT_MIN_LEN === "3" ? "19350" : "19450"
    },
    stdio: ["ignore", logFile.fd, logFile.fd],
    detached: false
  });

  children.set(i, { child, logPath });

  child.on("exit", code => {
    logFile.close().catch(() => {});
    console.log(`Cleanup-rev w${i} exited code=${code}`);
    const cur = children.get(i);
    if (cur?.child === child) {
      children.set(i, { child: null, logPath });
    }
    if (code !== 0 && DRY_RUN === "0") {
      setTimeout(() => {
        console.log(`Respawning cleanup-rev w${i}`);
        startCleanupWorker(i, { appendLog: true }).catch(console.error);
      }, 8000);
    }
  });

  console.log(`Cleanup-rev w${i} pid=${child.pid} → ${logPath}`);
}

async function main() {
  console.log(
    [
      `Starting ${WORKERS} parallel REVERSE (Z→A) queue cleaners`,
      `DRY_RUN=${DRY_RUN}`,
      `parents=${PARENT_MIN_LEN}-letter, prune queue items >=${CHILD_MIN_LEN} chars`,
      `stagger=${STAGGER_MS}ms`,
      `Logs: ${LOG_PREFIX}-0.log … ${LOG_PREFIX}-11.log`,
      "Stop: pkill -f 'node cleanup-queue-reverse.mjs'; pkill -f 'node run-cleanup-reverse-12.mjs'"
    ].join("\n")
  );

  for (let i = 0; i < WORKERS; i++) {
    await startCleanupWorker(i);
    if (i < WORKERS - 1) {
      await sleep(STAGGER_MS);
    }
  }

  if (DRY_RUN === "0") {
    setInterval(() => {
      mergeOnce().catch(error => {
        console.error("merge error:", error.message);
      });
    }, MERGE_EVERY_MS);
  }

  await new Promise(() => {});
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
