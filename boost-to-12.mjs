/**
 * Scale remaining work to 12 workers: 4 parent groups × (1 + 2 helpers).
 *
 * CD queue (w1) → 2 groups × 3-way = 6 workers
 *   A: w1 + w21 + w22
 *   B: w12 + w13 + w14
 *
 * ST queues (w9/17/18/19/20) → merged, then 2 groups × 3-way = 6 workers
 *   A: w18 + w23 + w24
 *   B: w20 + w19 + w25
 *
 * Helper IDs stay outside run-12's 0–11 set (except parent w1).
 */
import fs from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import path from "node:path";

const DIR = process.cwd();
const TS = Math.floor(Date.now() / 1000);

const GROUPS = [
  {
    letters: "cd",
    sourceIds: [1],
    owners: [1, 21, 22], // parent w1 kept by run-12 supervisor
    parentId: 1
  },
  {
    letters: "cd",
    sourceIds: [1], // same cd pool — split after 2-way parent split
    owners: [12, 13, 14],
    parentId: 12
  },
  {
    letters: "st",
    sourceIds: [9, 17, 18, 19, 20],
    owners: [18, 23, 24],
    parentId: 18
  },
  {
    letters: "st",
    sourceIds: [9, 17, 18, 19, 20],
    owners: [20, 19, 25],
    parentId: 20
  }
];

const ALL_STOP = [1, 9, 12, 13, 14, 17, 18, 19, 20, 21, 22, 23, 24, 25];
const START_HELPERS = [12, 13, 14, 18, 19, 20, 21, 22, 23, 24, 25]; // not w1

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function liveAuditWorkers() {
  const out = execSync("ps aux", { encoding: "utf8" });
  const live = new Map();
  for (const line of out.split("\n")) {
    if (!line.includes("node audit.mjs")) continue;
    const pid = line.trim().split(/\s+/)[1];
    if (!pid) continue;
    try {
      const env = execSync(`ps eww -p ${pid}`, { encoding: "utf8" });
      const m = env.match(/\bWORKER_ID=(\d+)/);
      if (m) live.set(Number(m[1]), Number(pid));
    } catch {
      // gone
    }
  }
  return live;
}

async function readState(id) {
  try {
    return JSON.parse(
      await fs.readFile(path.join(DIR, `lll-audit-state-${id}.json`), "utf8")
    );
  } catch {
    return null;
  }
}

async function writeState(id, state) {
  const file = path.join(DIR, `lll-audit-state-${id}.json`);
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(state), "utf8");
  await fs.rename(tmp, file);
}

async function backupState(id) {
  const src = path.join(DIR, `lll-audit-state-${id}.json`);
  const dst = path.join(
    DIR,
    `lll-audit-state-${id}.json.bak-before-boost12-${TS}`
  );
  try {
    await fs.copyFile(src, dst);
    return dst;
  } catch {
    return null;
  }
}

function roundRobinSplit(queue, n) {
  const buckets = Array.from({ length: n }, () => []);
  queue.forEach((item, i) => buckets[i % n].push(item));
  return buckets;
}

function uniqPreserve(items) {
  const seen = new Set();
  const out = [];
  for (const x of items) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function unionArrays(...lists) {
  return uniqPreserve(lists.flat());
}

async function stopWorkers(ids) {
  const live = liveAuditWorkers();
  const targets = [];
  for (const id of ids) {
    const pid = live.get(id);
    if (!pid) continue;
    console.log(`SIGTERM w${id} pid=${pid}`);
    try {
      process.kill(pid, "SIGTERM");
      targets.push({ id, pid });
    } catch (err) {
      console.log(`  kill failed: ${err.message}`);
    }
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const now = liveAuditWorkers();
    if (!targets.some(t => now.get(t.id) === t.pid)) {
      console.log("Target workers stopped");
      return;
    }
    await sleep(400);
  }
  // force
  const still = liveAuditWorkers();
  for (const t of targets) {
    if (still.get(t.id) === t.pid) {
      console.log(`SIGKILL w${t.id} pid=${t.pid}`);
      try {
        process.kill(t.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  await sleep(1000);
}

async function stopDaemon(name, pidfile) {
  try {
    const raw = await fs.readFile(path.join(DIR, pidfile), "utf8");
    const pid = Number(raw.trim());
    if (pid) {
      console.log(`Stopping ${name} pid=${pid}`);
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // ignore
      }
      await sleep(1500);
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // dead
      }
    }
  } catch {
    console.log(`${name} not running`);
  }
  await fs.unlink(path.join(DIR, pidfile)).catch(() => {});
}

async function startHelper(id, letters) {
  const profileDir = `/tmp/lll-pw-w${id}`;
  await fs.mkdir(profileDir, { recursive: true });
  await fs.unlink(`/tmp/lll-audit-w${id}.lock`).catch(() => {});
  const logPath = path.join(DIR, `worker-${id}.log`);
  const logFile = await fs.open(logPath, "a");
  await logFile.write(
    `\n--- boost-12 start ${new Date().toISOString()} letters=${letters} ---\n`
  );
  const child = spawn("node", ["audit.mjs"], {
    cwd: DIR,
    env: {
      ...process.env,
      TARGET_URL: process.env.TARGET_URL ?? "https://lastletterlibrary.com",
      COOLDOWN_MS: process.env.COOLDOWN_MS ?? "0",
      PROXY_MODE: process.env.PROXY_MODE ?? "tor",
      PROXY_LIST: process.env.PROXY_LIST ?? "proxies.txt",
      LIBRARY_MODE: process.env.LIBRARY_MODE ?? "pro",
      MIN_GAP_MS: process.env.MIN_GAP_MS ?? "15500",
      SEARCH_MODE: process.env.SEARCH_MODE ?? "direct",
      FAST_MODE: process.env.FAST_MODE ?? "1",
      WORKER_ID: String(id),
      LETTERS: letters,
      PROFILE_DIR: profileDir,
      CDP_URL: "",
      RESET: "0"
    },
    stdio: ["ignore", logFile.fd, logFile.fd],
    detached: true
  });
  child.unref();
  await logFile.close();
  console.log(`Started w${id} pid=${child.pid} letters=${letters}`);
}

async function collectPool(letters, sourceIds) {
  const queues = [];
  const completedLists = [];
  const wordsLists = [];
  let libraryMode = "pro";
  for (const id of sourceIds) {
    const s = await readState(id);
    if (!s) continue;
    if (s.letters && s.letters !== letters) continue;
    libraryMode = s.libraryMode ?? libraryMode;
    if (Array.isArray(s.queue)) queues.push(...s.queue);
    if (Array.isArray(s.completed)) completedLists.push(s.completed);
    if (Array.isArray(s.words)) wordsLists.push(s.words);
  }
  return {
    letters,
    libraryMode,
    queue: uniqPreserve(queues),
    completed: unionArrays(...completedLists),
    words: unionArrays(...wordsLists)
  };
}

async function main() {
  console.log("Stopping st-helpers daemon…");
  await stopDaemon("st-helpers-daemon", "st-helpers-daemon.pid");

  console.log("Stopping live audit workers for clean handoff…");
  await stopWorkers(ALL_STOP);
  await sleep(2000);

  // Supervisor may have already respawned w1 — stop again before write.
  if (liveAuditWorkers().has(1)) {
    console.log("w1 respawned early — stopping again");
    await stopWorkers([1]);
    await sleep(1000);
  }

  for (const id of ALL_STOP) {
    await backupState(id);
  }

  const cdPool = await collectPool("cd", [1]);
  const stPool = await collectPool("st", [9, 17, 18, 19, 20]);
  console.log(`CD pool queue=${cdPool.queue.length} words=${cdPool.words.length}`);
  console.log(`ST pool queue=${stPool.queue.length} words=${stPool.words.length}`);

  // 2-way parent split per letter, then each parent group is 3-way.
  const cdHalves = roundRobinSplit(cdPool.queue, 2);
  const stHalves = roundRobinSplit(stPool.queue, 2);

  const groupQueues = [
    { ...GROUPS[0], queue: cdHalves[0], pool: cdPool },
    { ...GROUPS[1], queue: cdHalves[1], pool: cdPool },
    { ...GROUPS[2], queue: stHalves[0], pool: stPool },
    { ...GROUPS[3], queue: stHalves[1], pool: stPool }
  ];

  const manifest = {
    at: new Date().toISOString(),
    totalWorkers: 12,
    groups: []
  };

  const allOwnerIds = [];

  for (const g of groupQueues) {
    const buckets = roundRobinSplit(g.queue, g.owners.length);
    const groupMeta = {
      letters: g.letters,
      parentId: g.parentId,
      owners: g.owners,
      before: g.queue.length,
      workers: {}
    };
    console.log(
      `\n${g.letters} group parent=w${g.parentId} queue=${g.queue.length} → ${g.owners.join(",")}`
    );
    for (let i = 0; i < g.owners.length; i++) {
      const id = g.owners[i];
      const slice = buckets[i];
      allOwnerIds.push(id);
      const state = {
        workerId: String(id),
        letters: g.letters,
        libraryMode: g.pool.libraryMode ?? "pro",
        queue: slice,
        completed: [...g.pool.completed],
        words: [...g.pool.words]
      };
      await writeState(id, state);
      await fs.writeFile(
        path.join(DIR, `last-${id}.txt`),
        [...g.pool.words].sort((a, b) => a.localeCompare(b)).join("\n") +
          (g.pool.words.length ? "\n" : ""),
        "utf8"
      );
      groupMeta.workers[id] = {
        role: id === g.parentId ? "parent" : "helper",
        count: slice.length,
        sample: slice.slice(0, 5)
      };
      console.log(
        `  w${id}: queue=${slice.length} sample=${slice.slice(0, 5).join(",")}`
      );
    }
    manifest.groups.push(groupMeta);
  }

  // Clear drained leftover helper states that we intentionally emptied
  // (w9, w17 no longer own queue slices in this plan).
  for (const id of [9, 17]) {
    const s = await readState(id);
    if (!s) continue;
    s.queue = [];
    await writeState(id, s);
  }

  // Disjoint check across all 12
  const seen = new Map();
  let overlap = 0;
  for (const id of allOwnerIds) {
    const s = await readState(id);
    for (const q of s.queue) {
      if (seen.has(q)) {
        console.error(`OVERLAP ${q} w${seen.get(q)} and w${id}`);
        overlap++;
      } else seen.set(q, id);
    }
  }
  if (overlap) throw new Error(`Split has ${overlap} overlaps`);
  console.log(`\nOK disjoint total=${seen.size} across ${allOwnerIds.length} workers`);

  await fs.writeFile(
    path.join(DIR, "boost-12-split-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );

  // Clear locks then start helpers (stagger)
  for (const id of START_HELPERS) {
    await fs.unlink(`/tmp/lll-audit-w${id}.lock`).catch(() => {});
  }
  await fs.unlink(`/tmp/lll-audit-w1.lock`).catch(() => {});

  for (const id of START_HELPERS) {
    const s = await readState(id);
    if (!s?.queue?.length) {
      console.log(`Skip start w${id} — empty queue`);
      continue;
    }
    await startHelper(id, s.letters);
    await sleep(3500);
  }

  console.log(
    "\nDone. Supervisor should respawn w1; boost-12-helpers-daemon keeps the rest."
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
