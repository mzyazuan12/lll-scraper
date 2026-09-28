/**
 * Temporary one-bot queue cleaner.
 *
 * Walks lll-audit-state-0.json … lll-audit-state-N.json in order.
 * For each state, finds 3-letter parents with 4+ letter descendants still
 * in queue (legacy full-page splits). Re-searches the 3-letter parent,
 * adds all returned words, and prunes covered queue branches using the
 * same planChildrenFromFullPage logic as audit.mjs.
 *
 * Does NOT modify completed[] — queue cleanup only.
 *
 * Pause the 12 scrapers before running (they will race on the same JSON).
 *
 *   node cleanup-queue.mjs
 *   DRY_RUN=1 node cleanup-queue.mjs   # no API, just print pruning plan
 */

import fs from "node:fs/promises";
import path from "node:path";

// Configure audit module before import (audit.mjs skips main() when imported).
const STATE_INDEX = process.env.STATE_INDEX ?? "";
const CLEANUP_ID = process.env.CLEANUP_ID ?? STATE_INDEX;

process.env.WORKER_ID ??= CLEANUP_ID !== "" ? String(CLEANUP_ID) : "99";
process.env.LETTERS ??= "cleanup";
process.env.PROFILE_DIR ??=
  CLEANUP_ID !== ""
    ? `/tmp/lll-pw-cleanup-w${CLEANUP_ID}`
    : "/tmp/lll-pw-cleanup";
process.env.TOR_BASE_PORT ??=
  CLEANUP_ID !== "" ? "19250" : "19100";
process.env.MIN_GAP_MS ??= "15200";
process.env.LIBRARY_MODE ??= "pro";
process.env.SEARCH_MODE ??= "direct";
process.env.FAST_MODE ??= "1";
process.env.PROXY_MODE ??= "tor";
process.env.TARGET_URL ??= "https://lastletterlibrary.com";

const DRY_RUN = process.env.DRY_RUN === "1";
const STATE_FROM = Number(
  process.env.STATE_FROM ?? (CLEANUP_ID !== "" ? CLEANUP_ID : "0")
);
const STATE_TO = Number(
  process.env.STATE_TO ?? (CLEANUP_ID !== "" ? CLEANUP_ID : "11")
);
const PARENT_MIN_LEN = Number(process.env.PARENT_MIN_LEN ?? "3");
const PARENT_MAX_LEN = Number(process.env.PARENT_MAX_LEN ?? "3");
const CHILD_MIN_LEN = Number(process.env.CHILD_MIN_LEN ?? "4");

const audit = await import("./audit.mjs");
const {
  LIMIT,
  assertAuthorizedTarget,
  extractWord,
  launchSession,
  loadProxyList,
  mergeSharedOutput,
  performSearchDirect,
  planChildrenFromFullPage,
  preparePage,
  ProxyRotator,
  sleep,
  torReachable,
  WorkerTor
} = audit;

const TAG = `[cleanup:w${process.env.WORKER_ID}]`;

function log(...parts) {
  const line = `${TAG} ${parts.join(" ")}\n`;
  process.stdout.write(line);
}

function stateFilesInRange() {
  const files = [];
  for (let i = STATE_FROM; i <= STATE_TO; i++) {
    files.push(`lll-audit-state-${i}.json`);
  }
  return files;
}

/** 3-letter parents that still have 4+ letter work sitting in queue. */
function findParentsToClean(queue) {
  const parents = new Set();
  for (const item of queue) {
    if (item.length >= CHILD_MIN_LEN) {
      parents.add(item.slice(0, PARENT_MIN_LEN));
    }
  }
  return [...parents].sort();
}

function queueItemCovered(item, parent, plan, fullPage) {
  if (!item.startsWith(parent) || item.length < CHILD_MIN_LEN) {
    return false;
  }
  if (!fullPage) {
    // Parent branch complete — all queued descendants are redundant.
    return true;
  }
  for (const skipped of plan.skipped) {
    if (item === skipped || item.startsWith(skipped)) {
      return true;
    }
  }
  return false;
}

async function loadWorkerState(stateFile) {
  const raw = JSON.parse(await fs.readFile(stateFile, "utf8"));
  return {
    stateFile,
    workerId: String(raw.workerId ?? "0"),
    letters: raw.letters ?? "",
    libraryMode: raw.libraryMode ?? "pro",
    queue: Array.isArray(raw.queue) ? [...raw.queue] : [],
    completed: new Set(Array.isArray(raw.completed) ? raw.completed : []),
    words: new Set(Array.isArray(raw.words) ? raw.words : [])
  };
}

async function saveWorkerState(state) {
  const payload = {
    workerId: state.workerId,
    letters: state.letters,
    libraryMode: state.libraryMode,
    queue: state.queue,
    completed: [...state.completed],
    words: [...state.words]
  };
  const outputFile = `last-${state.workerId}.txt`;

  await fs.writeFile(state.stateFile, JSON.stringify(payload), "utf8");
  await fs.writeFile(
    outputFile,
    [...state.words]
      .sort((a, b) => a.localeCompare(b))
      .join("\n") + (state.words.size ? "\n" : ""),
    "utf8"
  );
}

function simulateCleanup(state, parent, records) {
  const pageWords = [];
  const newWords = [];
  for (const record of records) {
    const word = extractWord(record);
    if (!word) {
      continue;
    }
    pageWords.push(word);
    if (!state.words.has(word)) {
      state.words.add(word);
      newWords.push(word);
    }
  }

  const fullPage = records.length >= LIMIT;
  const before = state.queue.length;
  let plan = { skipped: [], children: [], lastNext: null, lastWord: null };

  if (fullPage) {
    plan = planChildrenFromFullPage(parent, pageWords);
    state.queue = state.queue.filter(
      item => !queueItemCovered(item, parent, plan, true)
    );
  } else if (records.length > 0) {
    state.queue = state.queue.filter(
      item => !queueItemCovered(item, parent, plan, false)
    );
  }

  const removed = before - state.queue.length;
  return { pageWords, newWords, fullPage, plan, removed, before };
}

async function openBrowserSession() {
  assertAuthorizedTarget(process.env.TARGET_URL);

  const proxyList = await loadProxyList();
  let mode = (process.env.PROXY_MODE ?? "auto").toLowerCase();
  const workerTor = new WorkerTor(process.env.WORKER_ID);

  if (mode === "auto") {
    try {
      await fs.access("/opt/homebrew/bin/tor");
      mode = "tor";
    } catch {
      mode = (await torReachable("socks5://127.0.0.1:9050"))
        ? "tor"
        : proxyList.length
          ? "list"
          : "off";
    }
  }
  if (process.env.REQUIRE_TOR !== "0" && mode !== "tor") {
    throw new Error(
      `Cleanup workers require Tor (resolved PROXY_MODE=${mode})`
    );
  }

  const rotator = new ProxyRotator({
    mode,
    list: proxyList,
    workerTor: mode === "tor" ? workerTor : null
  });

  const baseProfile = process.env.PROFILE_DIR;
  let rotation = 0;
  let context = null;
  let page = null;

  async function openFresh() {
    if (context) {
      await context.close().catch(() => {});
      context = null;
      page = null;
    }

    const profileDir =
      mode === "off" ? baseProfile : `${baseProfile}-r${rotation}`;
    if (mode !== "off") {
      await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(profileDir, { recursive: true });
    } else {
      await fs.mkdir(profileDir, { recursive: true });
    }

    const proxy = mode === "off" ? null : await rotator.next();
    log(
      `Browser mode=${mode}` +
        (proxy ? ` via ${proxy.label || proxy.server}` : "") +
        (rotation ? ` rotation=${rotation}` : "")
    );

    const session = await launchSession({ profileDir, proxy });
    context = session.context;
    page = await preparePage(context);
    return page;
  }

  page = await openFresh();

  return {
    get page() {
      return page;
    },
    workerTor,
    async rotate(reason) {
      rotation += 1;
      log(`Rotating IP (#${rotation}) after ${reason}`);
      page = await openFresh();
      return page;
    },
    async close() {
      if (context) {
        await context.close().catch(() => {});
      }
      await workerTor.stop().catch(() => {});
    }
  };
}

async function searchWithRetry(session, prefix, { attempts = 4 } = {}) {
  let lastError = null;
  let turnstileMisses = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await performSearchDirect({ page: session.page, prefix });
    } catch (error) {
      lastError = error;
      const msg = String(error.message ?? error);
      const retryMs = /wait\s+(\d+)/i.exec(msg)?.[1];
      if (retryMs) {
        const wait = (Number(retryMs) + 1) * 1000;
        log(`429 on "${prefix}" — wait ${wait}ms (attempt ${attempt})`);
        await sleep(wait);
        continue;
      }
      if (/No Turnstile token/i.test(msg)) {
        turnstileMisses += 1;
        if (turnstileMisses >= 2) {
          await session.rotate(`Turnstile stuck on "${prefix}"`);
          turnstileMisses = 0;
          continue;
        }
        log(`Turnstile miss on "${prefix}" — reload (attempt ${attempt})`);
        await session.page.goto(process.env.TARGET_URL, {
          waitUntil: "domcontentloaded",
          timeout: 90_000
        });
        await sleep(1500);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function processStateFile(stateFile, session) {
  let state;
  try {
    state = await loadWorkerState(stateFile);
  } catch (error) {
    if (error.code === "ENOENT") {
      log(`Skip missing ${stateFile}`);
      return { parents: 0, removed: 0, searches: 0 };
    }
    throw error;
  }

  const parents = findParentsToClean(state.queue);
  log(
    `${stateFile} w${state.workerId}: queue=${state.queue.length} ` +
      `completed=${state.completed.size} words=${state.words.size} ` +
      `parents=${parents.length}`
  );

  if (!parents.length) {
    return { parents: 0, removed: 0, searches: 0 };
  }

  let totalRemoved = 0;
  let searches = 0;

  for (const parent of parents) {
    const stillHas = state.queue.some(
      item => item.startsWith(parent) && item.length >= CHILD_MIN_LEN
    );
    if (!stillHas) {
      continue;
    }

    const queuedUnder = state.queue.filter(
      item => item.startsWith(parent) && item.length >= CHILD_MIN_LEN
    ).length;

    if (DRY_RUN) {
      log(
        `[dry-run] would search "${parent}" (${queuedUnder} queued descendants)`
      );
      continue;
    }

    log(`Searching parent "${parent}" (${queuedUnder} queued descendants)`);

    let records = null;
    let lastError = null;
    // Never permanently skip a parent — rotate + retry until success.
    for (let tryN = 1; tryN <= 8; tryN++) {
      try {
        const result = await searchWithRetry(session, parent, {
          attempts: 4
        });
        records = result.records ?? [];
        searches += 1;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        log(
          `FAILED "${parent}" try ${tryN}/8: ${String(error.message).slice(0, 140)}`
        );
        if (session?.rotate) {
          try {
            await session.rotate(`retry "${parent}" after failure`);
          } catch (rotErr) {
            log(
              `rotate failed: ${String(rotErr.message).slice(0, 120)}`
            );
            await sleep(5000 * tryN);
          }
        } else {
          await sleep(3000 * tryN);
        }
      }
    }

    if (records == null) {
      log(
        `GAVE UP "${parent}" after retries — leaving queue intact: ${String(lastError?.message).slice(0, 120)}`
      );
      continue;
    }

    const { newWords, fullPage, plan, removed, before } = simulateCleanup(
      state,
      parent,
      records
    );
    totalRemoved += removed;

    if (fullPage) {
      log(
        `"${parent}" full page (${records.length}) ends "${plan.lastWord}" ` +
          `next='${plan.lastNext}' — skip ${plan.skipped.length} groups, ` +
          `removed ${removed}/${before} queue items, +${newWords.length} words`
      );
    } else {
      log(
        `"${parent}" partial (${records.length}) branch complete — ` +
          `removed ${removed}/${before} queue items, +${newWords.length} words`
      );
    }

    await saveWorkerState(state);
  }

  return { parents: parents.length, removed: totalRemoved, searches };
}

async function main() {
  log(
    [
      `Queue cleanup bot (DRY_RUN=${DRY_RUN})`,
      `states=${STATE_FROM}..${STATE_TO}`,
      `parents=${PARENT_MIN_LEN}-letter, prune queue items >=${CHILD_MIN_LEN} chars`,
      "completed[] is never modified"
    ].join(" | ")
  );

  const files = stateFilesInRange();
  let session = null;

  if (!DRY_RUN) {
    session = await openBrowserSession();
  }

  let grandRemoved = 0;
  let grandSearches = 0;

  try {
    for (const stateFile of files) {
      const stats = await processStateFile(stateFile, session ?? null);
      grandRemoved += stats.removed;
      grandSearches += stats.searches;
      log(
        `${stateFile} done — parents=${stats.parents} ` +
          `searches=${stats.searches} removed=${stats.removed}`
      );
    }

    if (!DRY_RUN && CLEANUP_ID === "") {
      const total = await mergeSharedOutput();
      log(`Merged last.txt → ${total.toLocaleString()} words`);
    } else if (!DRY_RUN && CLEANUP_ID !== "") {
      log(`State ${STATE_FROM} cleanup finished (supervisor merges last.txt)`);
    }

    log(
      `All states processed. searches=${grandSearches} queue_removed=${grandRemoved}`
    );
  } finally {
    if (session) {
      await session.close();
    }
  }
}

main().catch(error => {
  console.error(TAG, error);
  process.exit(1);
});
