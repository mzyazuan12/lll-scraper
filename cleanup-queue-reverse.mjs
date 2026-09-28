/**
 * Reverse (Z→A) queue cleaner.
 *
 * For each 3-letter parent that still has 4+ letter descendants in queue:
 *   1. Re-search the parent with sort=[{type:"alphabetical",direction:"desc"}]
 *      (same as clicking A-Z → Z-A in the UI).
 *   2. Plan covered groups from the reverse page (high letters fully listed).
 *   3. Prune those covered descendants from the queue (empty from the Z end),
 *      leaving the reverse-page boundary group and anything below it.
 *
 * Does NOT touch completed[]. Pause main scrapers first.
 *
 *   node cleanup-queue-reverse.mjs
 *   DRY_RUN=1 node cleanup-queue-reverse.mjs
 */

import fs from "node:fs/promises";

const STATE_INDEX = process.env.STATE_INDEX ?? "";
const CLEANUP_ID = process.env.CLEANUP_ID ?? STATE_INDEX;

process.env.WORKER_ID ??= CLEANUP_ID !== "" ? String(CLEANUP_ID) : "98";
process.env.LETTERS ??= "cleanup-rev";
process.env.PROFILE_DIR ??=
  CLEANUP_ID !== ""
    ? `/tmp/lll-pw-cleanup-rev-w${CLEANUP_ID}`
    : "/tmp/lll-pw-cleanup-rev";
process.env.TOR_BASE_PORT ??=
  CLEANUP_ID !== "" ? "19350" : "19300";
process.env.MIN_GAP_MS ??= "15500";
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
const CHILD_MIN_LEN = Number(process.env.CHILD_MIN_LEN ?? "4");

const REVERSE_SORT = [{ type: "alphabetical", direction: "desc" }];

const audit = await import("./audit.mjs");
const {
  LIMIT,
  assertAuthorizedTarget,
  extractWord,
  launchSession,
  loadProxyList,
  mergeSharedOutput,
  performSearchDirect,
  planChildrenFromFullPageReverse,
  preparePage,
  ProxyRotator,
  sleep,
  torReachable,
  WorkerTor
} = audit;

const TAG = `[cleanup-rev:w${process.env.WORKER_ID}]`;

function log(...parts) {
  process.stdout.write(`${TAG} ${parts.join(" ")}\n`);
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
    // Parent branch complete in reverse — all queued descendants redundant.
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

function simulateReverseCleanup(state, parent, records) {
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
  let plan = {
    skipped: [],
    children: [],
    lastNext: null,
    firstNext: null,
    lastWord: null,
    firstWord: null
  };

  if (fullPage) {
    // Keep both the reverse-start (highest next-char) and the reverse-end
    // (lowest next-char on the page) as boundary seeds; remove the covered
    // middle groups. Matches the UI Z→A cleanup where both extremes stay queued.
    plan = planChildrenFromFullPageReverse(parent, pageWords, {
      keepBothExtremes: true
    });
    state.queue = state.queue.filter(
      item => !queueItemCovered(item, parent, plan, true)
    );
    // Preserve both boundary groups if they are not already queued or completed.
    for (const child of plan.children) {
      if (!state.queue.includes(child) && !state.completed.has(child)) {
        state.queue.push(child);
      }
    }
  } else if (records.length > 0) {
    state.queue = state.queue.filter(
      item => !queueItemCovered(item, parent, plan, false)
    );
  }

  const removed = before - state.queue.length;
  const remainingUnder = state.queue.filter(
    item => item.startsWith(parent) && item.length >= CHILD_MIN_LEN
  );
  return { pageWords, newWords, fullPage, plan, removed, before, remainingUnder };
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

async function searchReverseWithRetry(session, prefix, { attempts = 4 } = {}) {
  let lastError = null;
  let turnstileMisses = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await performSearchDirect({
        page: session.page,
        prefix,
        sort: REVERSE_SORT
      });
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
      `parents=${parents.length} (reverse Z→A)`
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
    );
    const queuedChars = [
      ...new Set(queuedUnder.map(item => item[PARENT_MIN_LEN] ?? "?"))
    ].sort();

    if (DRY_RUN) {
      log(
        `[dry-run] would reverse-search "${parent}" ` +
          `(${queuedUnder.length} queued, chars=${queuedChars.join("")})`
      );
      continue;
    }

    log(
      `Reverse-searching parent "${parent}" ` +
        `(${queuedUnder.length} queued descendants, chars=${queuedChars.join("")})`
    );

    let records = null;
    let lastError = null;
    for (let tryN = 1; tryN <= 8; tryN++) {
      try {
        const result = await searchReverseWithRetry(session, parent, {
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

    const {
      newWords,
      fullPage,
      plan,
      removed,
      before,
      remainingUnder
    } = simulateReverseCleanup(state, parent, records);
    totalRemoved += removed;

    const remainChars = [
      ...new Set(remainingUnder.map(item => item[PARENT_MIN_LEN] ?? "?"))
    ].sort();

    if (fullPage) {
      const keep = plan.lastNext !== plan.firstNext && plan.lastNext
        ? `${plan.firstNext}+${plan.lastNext}`
        : plan.firstNext;
      log(
        `"${parent}" reverse full page (${records.length}) ` +
          `start="${plan.firstWord}" first='${plan.firstNext}' ` +
          `end="${plan.lastWord}" next='${plan.lastNext}' — ` +
          `remove ${plan.skipped.length} covered groups, keep '${keep}', ` +
          `removed ${removed}/${before} queue items, leave chars=${remainChars.join("") || "∅"}, ` +
          `+${newWords.length} words`
      );
    } else {
      log(
        `"${parent}" reverse partial (${records.length}) branch complete — ` +
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
      `Reverse queue cleanup bot (DRY_RUN=${DRY_RUN})`,
      `states=${STATE_FROM}..${STATE_TO}`,
      `sort=alphabetical:desc (Z→A)`,
      `parents=${PARENT_MIN_LEN}-letter, prune queue items >=${CHILD_MIN_LEN} chars from high end`,
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
      log(`State ${STATE_FROM} reverse cleanup finished`);
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
