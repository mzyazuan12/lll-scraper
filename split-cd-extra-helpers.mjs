/**
 * Add one helper per remaining CD parent and round-robin-split each queue
 * into two disjoint slices (parent keeps even indices, helper gets odd).
 *
 *   w1  → w26
 *   w12 → w27
 *   w13 → w28
 *   w14 → w29
 *   w21 → w30
 *   w22 → w31
 */
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";

const DIR = process.cwd();
const TS = Math.floor(Date.now() / 1000);

const PAIRS = [
  { parent: 1, helper: 26 },
  { parent: 12, helper: 27 },
  { parent: 13, helper: 28 },
  { parent: 14, helper: 29 },
  { parent: 21, helper: 30 },
  { parent: 22, helper: 31 }
];

const STOP_IDS = PAIRS.flatMap(p => [p.parent, p.helper]);

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
  const tmp = `${file}.tmp.${process.pid}.${id}`;
  await fs.writeFile(tmp, JSON.stringify(state), "utf8");
  await fs.rename(tmp, file);
}

async function backupState(id) {
  const src = path.join(DIR, `lll-audit-state-${id}.json`);
  const dst = path.join(
    DIR,
    `lll-audit-state-${id}.json.bak-before-cd-extra-${TS}`
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

async function stopDaemon() {
  const pidfile = path.join(DIR, "boost-12-helpers-daemon.pid");
  try {
    const pid = Number((await fs.readFile(pidfile, "utf8")).trim());
    if (pid) {
      console.log(`Stopping boost-12-helpers-daemon pid=${pid}`);
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
    console.log("boost-12-helpers-daemon not running");
  }
  await fs.unlink(pidfile).catch(() => {});
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
      console.log("Parents stopped");
      return;
    }
    await sleep(400);
  }
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

async function main() {
  console.log("Stopping daemon + parents for clean 2-way split…");
  await stopDaemon();
  await stopWorkers(STOP_IDS);
  await sleep(1500);

  // Daemon may have been mid-spawn; clear anything that came back.
  const again = [...liveAuditWorkers().keys()].filter(id =>
    STOP_IDS.includes(id)
  );
  if (again.length) {
    console.log(`Respawned still live: ${again.join(",")} — stopping again`);
    await stopWorkers(again);
    await sleep(1000);
  }

  const manifest = {
    at: new Date().toISOString(),
    pairs: [],
    collisions: []
  };

  for (const { parent, helper } of PAIRS) {
    await backupState(parent);
    const state = await readState(parent);
    if ((state.letters || "") !== "cd") {
      throw new Error(`w${parent} letters=${state.letters} (expected cd)`);
    }
    const queue = uniqPreserve(
      Array.isArray(state.queue) ? state.queue : []
    );
    const completed = Array.isArray(state.completed) ? state.completed : [];
    const words = Array.isArray(state.words) ? state.words : [];
    const [parentQ, helperQ] = roundRobinSplit(queue, 2);

    // Collision check across the two slices.
    const overlap = parentQ.filter(x => helperQ.includes(x));
    if (overlap.length) {
      manifest.collisions.push({ parent, helper, overlap });
      throw new Error(
        `Collision in w${parent}/w${helper}: ${overlap.slice(0, 5).join(",")}`
      );
    }

    const libraryMode = state.libraryMode ?? "pro";
    await writeState(parent, {
      workerId: String(parent),
      letters: "cd",
      libraryMode,
      queue: parentQ,
      completed,
      words
    });
    await writeState(helper, {
      workerId: String(helper),
      letters: "cd",
      libraryMode,
      queue: helperQ,
      // Share completed so helpers never re-search parent-finished prefixes.
      completed: [...completed],
      words: [...words]
    });

    // Seed helper output file from parent words for merge continuity.
    await fs.writeFile(
      path.join(DIR, `last-${helper}.txt`),
      [...words].sort((a, b) => a.localeCompare(b)).join("\n") +
        (words.length ? "\n" : ""),
      "utf8"
    );

    const entry = {
      parent,
      helper,
      before: queue.length,
      parentQueue: parentQ.length,
      helperQueue: helperQ.length,
      parentSample: parentQ.slice(0, 5),
      helperSample: helperQ.slice(0, 5)
    };
    manifest.pairs.push(entry);
    console.log(
      `w${parent} ${queue.length} → parent=${parentQ.length} helper w${helper}=${helperQ.length}`
    );
  }

  // Global uniqueness across all remaining CD queues.
  const all = [];
  for (const { parent, helper } of PAIRS) {
    for (const id of [parent, helper]) {
      const s = await readState(id);
      for (const item of s.queue || []) {
        all.push({ id, item });
      }
    }
  }
  const seen = new Map();
  for (const { id, item } of all) {
    if (seen.has(item)) {
      manifest.collisions.push({
        item,
        owners: [seen.get(item), id]
      });
    } else {
      seen.set(item, id);
    }
  }
  if (manifest.collisions.length) {
    throw new Error(
      `Cross-worker collisions: ${JSON.stringify(manifest.collisions.slice(0, 5))}`
    );
  }

  const out = path.join(DIR, "cd-extra-helpers-split-manifest.json");
  await fs.writeFile(out, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\nNo collisions. Manifest → ${path.basename(out)}`);
  console.log(
    `Total prefixes distributed: ${all.length} across ${PAIRS.length * 2} workers`
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
