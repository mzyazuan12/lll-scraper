/**
 * Pause w0/w2, round-robin-split their queues onto helper workers, restart.
 *
 * w0 (ab) → keep 1/4 on w0, give slices to w12/w13/w14
 * w2 (ef) → keep 1/3 on w2, give slices to w15/w16
 *
 * Helper IDs are outside run-12's 0–11 set so the supervisor won't fight them.
 * Each helper gets the parent's completed+words so child-planning won't
 * re-open finished prefixes, and drained queues don't restart root letters.
 */
import fs from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import path from "node:path";

const DIR = process.cwd();
const TS = Math.floor(Date.now() / 1000);

const PLANS = [
  {
    parentId: 0,
    letters: "ab",
    helpers: [12, 13, 14] // + parent = 4-way split
  },
  {
    parentId: 2,
    letters: "ef",
    helpers: [15, 16] // + parent = 3-way split
  }
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function liveAuditWorkers() {
  const out = execSync("ps aux", { encoding: "utf8" });
  const live = new Map(); // workerId -> pid
  for (const line of out.split("\n")) {
    if (!line.includes("node audit.mjs")) continue;
    const pid = line.trim().split(/\s+/)[1];
    if (!pid) continue;
    try {
      const env = execSync(`ps eww -p ${pid}`, { encoding: "utf8" });
      const m = env.match(/\bWORKER_ID=(\d+)/);
      if (m) live.set(Number(m[1]), Number(pid));
    } catch {
      // process may have exited
    }
  }
  return live;
}

async function readState(id) {
  const raw = await fs.readFile(
    path.join(DIR, `lll-audit-state-${id}.json`),
    "utf8"
  );
  return JSON.parse(raw);
}

async function writeState(id, state) {
  const file = path.join(DIR, `lll-audit-state-${id}.json`);
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(state), "utf8");
  await fs.rename(tmp, file);
}

async function backupState(id, tag) {
  const src = path.join(DIR, `lll-audit-state-${id}.json`);
  const dst = path.join(
    DIR,
    `lll-audit-state-${id}.json.bak-before-${tag}-${TS}`
  );
  await fs.copyFile(src, dst);
  return dst;
}

function roundRobinSplit(queue, bucketCount) {
  const buckets = Array.from({ length: bucketCount }, () => []);
  queue.forEach((item, i) => {
    buckets[i % bucketCount].push(item);
  });
  return buckets;
}

async function stopWorkers(ids) {
  const live = liveAuditWorkers();
  const targets = [];
  for (const id of ids) {
    const pid = live.get(id);
    if (pid) {
      console.log(`SIGTERM w${id} pid=${pid}`);
      try {
        process.kill(pid, "SIGTERM");
        targets.push({ id, pid });
      } catch (err) {
        console.log(`  kill failed: ${err.message}`);
      }
    } else {
      console.log(`w${id} not running`);
    }
  }

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const now = liveAuditWorkers();
    const still = targets.filter(t => now.get(t.id) === t.pid);
    if (!still.length) {
      console.log("Parents stopped");
      return;
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for w0/w2 to stop");
}

async function splitOne({ parentId, letters, helpers }) {
  const owners = [parentId, ...helpers];
  const bak = await backupState(parentId, "ab-ef-split");
  console.log(`Backed up w${parentId} → ${path.basename(bak)}`);

  // If supervisor already respawned parent, stop again before reading.
  const live = liveAuditWorkers();
  if (live.has(parentId)) {
    console.log(`w${parentId} already respawned — stopping again before split`);
    await stopWorkers([parentId]);
  }

  const parent = await readState(parentId);
  const queue = Array.isArray(parent.queue) ? [...parent.queue] : [];
  const completed = Array.isArray(parent.completed) ? parent.completed : [];
  const words = Array.isArray(parent.words) ? parent.words : [];

  console.log(
    `w${parentId} (${letters}) queue=${queue.length} → ${owners.length}-way split`
  );

  const buckets = roundRobinSplit(queue, owners.length);
  const manifest = {};

  for (let i = 0; i < owners.length; i++) {
    const id = owners[i];
    const slice = buckets[i];
    const state = {
      workerId: String(id),
      letters,
      libraryMode: parent.libraryMode ?? "pro",
      queue: slice,
      completed: [...completed],
      words: [...words]
    };
    if (id !== parentId) {
      await backupState(id, "ab-ef-split").catch(() => {});
      // Fresh per-helper word file; state still carries parent's words set
      // so newWords won't spam shared last.txt with duplicates.
      await fs.writeFile(
        path.join(DIR, `last-${id}.txt`),
        words.sort((a, b) => a.localeCompare(b)).join("\n") +
          (words.length ? "\n" : ""),
        "utf8"
      );
    }
    await writeState(id, state);
    manifest[id] = {
      role: id === parentId ? "parent" : "helper",
      assist: letters,
      count: slice.length,
      sample: slice.slice(0, 5)
    };
    console.log(
      `  w${id}: queue=${slice.length} sample=${slice.slice(0, 5).join(",")}`
    );
  }

  return manifest;
}

async function startHelper(id, letters) {
  const profileDir = `/tmp/lll-pw-w${id}`;
  await fs.mkdir(profileDir, { recursive: true });
  const logPath = path.join(DIR, `worker-${id}.log`);
  const logFile = await fs.open(logPath, "a");
  await logFile.write(
    `\n--- ab/ef-helper start ${new Date().toISOString()} letters=${letters} ---\n`
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
  console.log(`Started helper w${id} pid=${child.pid} letters=${letters}`);
  return child.pid;
}

async function main() {
  const parentIds = PLANS.map(p => p.parentId);
  console.log("Stopping parents for clean queue handoff…");
  await stopWorkers(parentIds);

  // Brief settle so final saveState flushes land on disk.
  await sleep(1500);

  const manifest = {
    at: new Date().toISOString(),
    plans: {}
  };

  for (const plan of PLANS) {
    manifest.plans[plan.parentId] = await splitOne(plan);
  }

  await fs.writeFile(
    path.join(DIR, "ab-ef-help-split-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
  console.log("Wrote ab-ef-help-split-manifest.json");

  // Start helpers staggered; supervisor will respawn w0/w2 on its own.
  const helperStarts = [
    [12, "ab"],
    [13, "ab"],
    [14, "ab"],
    [15, "ef"],
    [16, "ef"]
  ];
  for (const [id, letters] of helperStarts) {
    await startHelper(id, letters);
    await sleep(4000);
  }

  console.log("Done. Supervisor should respawn w0/w2 with reduced queues.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
