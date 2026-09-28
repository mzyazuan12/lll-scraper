/**
 * Pause w9, round-robin-split its queue onto 4 helpers (w17–w20).
 * 5-way split: parent keeps 1/5, helpers get disjoint slices.
 */
import fs from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import path from "node:path";

const DIR = process.cwd();
const TS = Math.floor(Date.now() / 1000);
const PARENT_ID = 9;
const LETTERS = "st";
const HELPERS = [17, 18, 19, 20];

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
  return JSON.parse(
    await fs.readFile(path.join(DIR, `lll-audit-state-${id}.json`), "utf8")
  );
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
    `lll-audit-state-${id}.json.bak-before-st-split-${TS}`
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

async function stopWorkers(ids) {
  const live = liveAuditWorkers();
  const targets = [];
  for (const id of ids) {
    const pid = live.get(id);
    if (!pid) {
      console.log(`w${id} not running`);
      continue;
    }
    console.log(`SIGTERM w${id} pid=${pid}`);
    try {
      process.kill(pid, "SIGTERM");
      targets.push({ id, pid });
    } catch (err) {
      console.log(`  kill failed: ${err.message}`);
    }
  }
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const now = liveAuditWorkers();
    if (!targets.some(t => now.get(t.id) === t.pid)) {
      console.log("Parents stopped");
      return;
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for w9 to stop");
}

async function startHelper(id, letters) {
  const profileDir = `/tmp/lll-pw-w${id}`;
  await fs.mkdir(profileDir, { recursive: true });
  const logPath = path.join(DIR, `worker-${id}.log`);
  const logFile = await fs.open(logPath, "a");
  await logFile.write(
    `\n--- st-helper start ${new Date().toISOString()} letters=${letters} ---\n`
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
}

async function main() {
  console.log("Stopping w9 for clean queue handoff…");
  await stopWorkers([PARENT_ID]);
  await sleep(1500);

  if (liveAuditWorkers().has(PARENT_ID)) {
    console.log("w9 respawned early — stopping again");
    await stopWorkers([PARENT_ID]);
    await sleep(1000);
  }

  const bak = await backupState(PARENT_ID);
  console.log(`Backed up w9 → ${bak ? path.basename(bak) : "(none)"}`);

  const parent = await readState(PARENT_ID);
  const queue = Array.isArray(parent.queue) ? [...parent.queue] : [];
  const completed = Array.isArray(parent.completed) ? parent.completed : [];
  const words = Array.isArray(parent.words) ? parent.words : [];
  const owners = [PARENT_ID, ...HELPERS];

  console.log(
    `w9 (${LETTERS}) queue=${queue.length} → ${owners.length}-way split`
  );
  const buckets = roundRobinSplit(queue, owners.length);
  const manifest = {
    at: new Date().toISOString(),
    parent: PARENT_ID,
    letters: LETTERS,
    workers: {}
  };

  for (let i = 0; i < owners.length; i++) {
    const id = owners[i];
    const slice = buckets[i];
    const state = {
      workerId: String(id),
      letters: LETTERS,
      libraryMode: parent.libraryMode ?? "pro",
      queue: slice,
      completed: [...completed],
      words: [...words]
    };
    if (id !== PARENT_ID) {
      await backupState(id);
      await fs.writeFile(
        path.join(DIR, `last-${id}.txt`),
        words.sort((a, b) => a.localeCompare(b)).join("\n") +
          (words.length ? "\n" : ""),
        "utf8"
      );
    }
    await writeState(id, state);
    manifest.workers[id] = {
      role: id === PARENT_ID ? "parent" : "helper",
      count: slice.length,
      sample: slice.slice(0, 5)
    };
    console.log(
      `  w${id}: queue=${slice.length} sample=${slice.slice(0, 5).join(",")}`
    );
  }

  // Disjoint check
  const seen = new Map();
  let overlap = 0;
  for (const id of owners) {
    const s = await readState(id);
    for (const q of s.queue) {
      if (seen.has(q)) {
        console.error(`OVERLAP ${q} w${seen.get(q)} and w${id}`);
        overlap++;
      } else seen.set(q, id);
    }
  }
  if (overlap) throw new Error(`Split has ${overlap} overlaps`);
  console.log(`OK disjoint total=${seen.size}`);

  await fs.writeFile(
    path.join(DIR, "st-help-split-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );

  for (const id of HELPERS) {
    await startHelper(id, LETTERS);
    await sleep(4000);
  }
  console.log("Done. Supervisor should respawn w9 with reduced queue.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
