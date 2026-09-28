process.env.WORKER_ID = "9";
process.env.LETTERS = "cleanup";
process.env.PROFILE_DIR = "/tmp/lll-pw-cleanup-w9";
process.env.TOR_BASE_PORT = "19250";
process.env.MIN_GAP_MS = "15200";
process.env.PROXY_MODE = "tor";
process.env.TARGET_URL = "https://lastletterlibrary.com";
process.env.LIBRARY_MODE = "pro";
process.env.SEARCH_MODE = "direct";

import fs from "node:fs/promises";
const audit = await import("./audit.mjs");
const {
  LIMIT, extractWord, launchSession, performSearchDirect,
  planChildrenFromFullPage, preparePage, ProxyRotator, sleep, WorkerTor, mergeSharedOutput
} = audit;

const PARENT = "sig";
const stateFile = "lll-audit-state-9.json";
const raw = JSON.parse(await fs.readFile(stateFile, "utf8"));
const words = new Set(raw.words || []);
let queue = [...raw.queue];

const workerTor = new WorkerTor("9");
const rotator = new ProxyRotator({ mode: "tor", list: [], workerTor });
const proxy = await rotator.next();
const profileDir = "/tmp/lll-pw-cleanup-w9-sig";
await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
await fs.mkdir(profileDir, { recursive: true });
const session = await launchSession({ profileDir, proxy });
const page = await preparePage(session.context);

let result = null;
for (let i = 1; i <= 6; i++) {
  try {
    result = await performSearchDirect({ page, prefix: PARENT });
    break;
  } catch (e) {
    console.log("fail", i, String(e.message).slice(0, 120));
    await sleep(2000 * i);
    if (i === 3 || i === 5) {
      await page.goto(process.env.TARGET_URL, {
        waitUntil: "domcontentloaded",
        timeout: 90000
      });
    }
  }
}
if (!result) throw new Error("sig failed");

const pageWords = [];
const newWords = [];
for (const r of result.records) {
  const w = extractWord(r);
  if (!w) continue;
  pageWords.push(w);
  if (!words.has(w)) {
    words.add(w);
    newWords.push(w);
  }
}

if (result.records.length >= LIMIT) {
  const plan = planChildrenFromFullPage(PARENT, pageWords);
  const before = queue.length;
  queue = queue.filter(item => {
    if (!(item.startsWith(PARENT) && item.length >= 4)) return true;
    return !plan.skipped.some(s => item === s || item.startsWith(s));
  });
  console.log(
    `sig full page ends ${plan.lastWord} next=${plan.lastNext} skip=${plan.skipped.length} removed=${before - queue.length}`
  );
} else {
  const before = queue.length;
  queue = queue.filter(item => !(item.startsWith(PARENT) && item.length >= 4));
  console.log(`sig partial removed=${before - queue.length}`);
}

raw.queue = queue;
raw.words = [...words];
await fs.writeFile(stateFile, JSON.stringify(raw), "utf8");
await fs.writeFile(
  "last-9.txt",
  [...words].sort((a, b) => a.localeCompare(b)).join("\n") + "\n",
  "utf8"
);
await mergeSharedOutput().catch(() => {});
await session.context.close().catch(() => {});
await workerTor.stop().catch(() => {});
console.log("sig cleaned +", newWords.length, "words");
