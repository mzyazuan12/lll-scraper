import { chromium } from "playwright";
import { spawn as spawnProcess } from "node:child_process";
import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const TARGET_URL =
  process.env.TARGET_URL ?? "http://localhost:3000";

const API_PATH = "/api/words/game";
const LIMIT = 100;
// Pro lexicon includes hyphen / apostrophe words — recurse into those too.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz-'";
const LIBRARY_MODE = (
  process.env.LIBRARY_MODE ?? "pro"
).toLowerCase();

const COOLDOWN_MS = Number(
  // Prefer 0: direct search skips the site's 15s UI Wait gate.
  process.env.COOLDOWN_MS ?? "0"
);

// FAST_MODE=1 (default): call /api/words/game via in-page fetch with a
// fresh Turnstile token. The site's "Wait Ns…" is client-only anti-spam on
// the Fortified Search button — not a server rule — so direct mode can be
// near-instant between searches (limited by Turnstile mint + any 429s).
// SEARCH_MODE=ui forces the old button-click path.
const FAST_MODE = process.env.FAST_MODE !== "0";
const SEARCH_MODE = (
  process.env.SEARCH_MODE ?? (FAST_MODE ? "direct" : "ui")
).toLowerCase();

// Adaptive gap between direct API searches. Live 429 bodies report the
// *remaining* cooldown (often 1–12s). The underlying window is ~15s/IP —
// the site's "Wait Ns…" UI gate matches that. Floor near the window so we
// don't burn Turnstile tokens on alternating 200/429 thrash; still learn UP
// if the server asks for longer, and gently probe down after long clean runs.
let adaptiveGapMs = Number(
  process.env.MIN_GAP_MS ?? (SEARCH_MODE === "direct" ? "15500" : "0")
);
const ANTIBOT_BACKOFF_MS = Math.max(
  0,
  Number(process.env.ANTIBOT_BACKOFF_MS ?? "60000")
);
let cleanSuccessStreak = 0;
let nextSearchAt = 0;
let lastRequestAt = 0;
const EXIT_IP_REGISTRY =
  process.env.EXIT_IP_REGISTRY ?? "/tmp/lll-exit-ips.json";
const MERGE_EVERY_N = Math.max(
  1,
  Number(process.env.MERGE_EVERY_N ?? "8")
);
let savesSinceMerge = 0;
let lastProgressAt = 0;

/*
 * Parallel workers:
 *   WORKER_ID=3 LETTERS=gh PROXY_MODE=tor node audit.mjs
 *
 * LETTERS are the root prefixes this worker owns (e.g. "gh").
 * One root letter is fully expanded (BFS) before the next root starts:
 *   g → (if 100) ga..gz → … → then h → ha..hz …
 */
const WORKER_ID = process.env.WORKER_ID ?? "0";
const LETTERS = (
  process.env.LETTERS ?? ALPHABET
)
  .toLowerCase()
  .replace(/[^a-z]/g, "");

const STATE_FILE =
  process.env.STATE_FILE ??
  `lll-audit-state-${WORKER_ID}.json`;

const OUTPUT_FILE =
  process.env.OUTPUT_FILE ??
  `last-${WORKER_ID}.txt`;

const SHARED_OUTPUT_FILE =
  process.env.SHARED_OUTPUT_FILE ?? "last.txt";

const CDP_URL = process.env.CDP_URL ?? "";
const MANUAL_TURNSTILE =
  process.env.MANUAL_TURNSTILE === "1";

/*
 * PROXY_MODE:
 *   tor     — socks5://127.0.0.1:9050 with IsolateSOCKSAuth per rotation
 *   list    — round-robin PROXY_LIST / proxies.txt
 *   off     — direct (system VPN / home IP)
 *   auto    — tor if reachable, else list, else off
 */
const PROXY_MODE = (
  process.env.PROXY_MODE ?? "tor"
).toLowerCase();
const REQUIRE_TOR = process.env.REQUIRE_TOR !== "0";

const TOR_SOCKS =
  process.env.TOR_SOCKS ?? "";

const TOR_BASE_PORT = Number(process.env.TOR_BASE_PORT ?? "19050");
const TOR_BASE_CONTROL_PORT = Number(
  process.env.TOR_BASE_CONTROL_PORT ?? "29050"
);
const TOR_BOOTSTRAP_TIMEOUT_MS = Number(
  process.env.TOR_BOOTSTRAP_TIMEOUT_MS ?? "150000"
);
const TOR_NEWNYM_WAIT_MS = Number(
  process.env.TOR_NEWNYM_WAIT_MS ?? "8000"
);

const PROXY_LIST_FILE =
  process.env.PROXY_LIST ?? "proxies.txt";

const TAG = `[w${WORKER_ID}:${LETTERS || "*"}:${LIBRARY_MODE}]`;
const WORKER_LOCK_FILE =
  process.env.WORKER_LOCK_FILE ?? `/tmp/lll-audit-w${WORKER_ID}.lock`;
let ownedWorkerLock = null;

function assertAuthorizedTarget(targetUrl) {
  const url = new URL(targetUrl);
  const hostname = url.hostname.toLowerCase();

  if (
    hostname === "lastletterlibrary.com" ||
    hostname === "www.lastletterlibrary.com"
  ) {
    return;
  }

  const authorized =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.startsWith("staging.");

  if (!authorized) {
    throw new Error(
      [
        `Refusing to run against: ${hostname}`,
        "Use lastletterlibrary.com, localhost, or a staging.* hostname."
      ].join("\n")
    );
  }
}

function sleep(milliseconds) {
  return new Promise(resolve =>
    setTimeout(resolve, milliseconds)
  );
}

async function raceWithTimeout(promise, timeoutMs, timeoutValue) {
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function atomicWriteFile(file, data) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, data, "utf8");
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

async function withFileLock(
  lockPath,
  fn,
  { timeoutMs = 10_000, staleMs = 30_000 } = {}
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let acquired = false;
    try {
      await fs.writeFile(lockPath, String(process.pid), { flag: "wx" });
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.unlink(lockPath).catch(() => {});
      } else {
        await sleep(40 + Math.floor(Math.random() * 80));
      }
    }

    if (!acquired) {
      continue;
    }

    try {
      return await fn();
    } finally {
      await fs.unlink(lockPath).catch(() => {});
    }
  }
  throw new Error(`Timed out acquiring file lock ${lockPath}`);
}

function releaseWorkerLockSync() {
  if (!ownedWorkerLock) {
    return;
  }
  try {
    unlinkSync(ownedWorkerLock);
  } catch {
    // Lock may already have been removed during graceful shutdown.
  }
  ownedWorkerLock = null;
}

async function acquireWorkerLock() {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await fs.writeFile(WORKER_LOCK_FILE, String(process.pid), {
        flag: "wx"
      });
      ownedWorkerLock = WORKER_LOCK_FILE;
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const owner = Number(
        await fs.readFile(WORKER_LOCK_FILE, "utf8").catch(() => "")
      );
      let alive = false;
      if (Number.isInteger(owner) && owner > 1) {
        try {
          process.kill(owner, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (alive) {
        throw new Error(
          `Worker ${WORKER_ID} is already active as pid ${owner}`
        );
      }
      await fs.unlink(WORKER_LOCK_FILE).catch(() => {});
    }
  }
  throw new Error(`Could not acquire worker lock ${WORKER_LOCK_FILE}`);
}

function log(...parts) {
  const line = `${TAG} ${parts.join(" ")}\n`;
  process.stdout.write(line);
  if (typeof process.stdout.flush === "function") {
    process.stdout.flush();
  }
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function isBannedIpError(error) {
  const message = String(error?.message ?? error ?? "");
  return /BANNED_IP|banned.?ip/i.test(message);
}

function isAntibotError(error) {
  const message = String(error?.message ?? error ?? "");
  return (
    /Anti-bot verification failed|Are you a robot|turnstile/i.test(
      message
    ) && /API 403|403/i.test(message)
  );
}

function isRotateWorthyError(error) {
  const message = String(error?.message ?? error ?? "");
  return (
    isBannedIpError(error) ||
    isAntibotError(error) ||
    /API 403|Failed to fetch|ERR_TIMED_OUT|ERR_PROXY|ERR_TUNNEL|ERR_SOCKS|Turnstile stuck|No Turnstile token|net::ERR_/i.test(
      message
    )
  );
}

function isTurnstileFailureError(error) {
  const message = String(error?.message ?? error ?? "");
  return /No Turnstile token|Turnstile miss|Turnstile stuck|Turnstile remint timed out|Turnstile mint hard timeout|Turnstile direct mint miss|cf-turnstile-response/i.test(
    message
  );
}

function parseRetryAfterMs(error) {
  const message = String(error?.message ?? error ?? "");
  const match =
    message.match(/wait\s+(\d+)\s*seconds?/i) ||
    message.match(/wait\s+(\d+)\s*s\b/i) ||
    message.match(/(\d+)\s*seconds?/i);
  if (match) {
    return (Number(match[1]) + 1) * 1000;
  }
  if (/API 429/i.test(message)) {
    return 20_000;
  }
  return null;
}

function portOpen(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

async function torReachable(socksUrl = TOR_SOCKS) {
  if (!socksUrl) {
    return false;
  }
  try {
    const url = new URL(socksUrl);
    return portOpen(
      url.hostname || "127.0.0.1",
      Number(url.port || 9050)
    );
  } catch {
    return false;
  }
}

/**
 * One Tor daemon per worker so Chrome (no SOCKS5 auth) still gets a unique exit.
 * Rotating = kill + fresh DataDirectory + new bootstrap.
 * Exit IPs are registered globally so two workers don't share a rate-limit bucket.
 */
class WorkerTor {
  constructor(workerId) {
    this.workerId = workerId;
    this.port = TOR_BASE_PORT + Number(workerId);
    this.controlPort = TOR_BASE_CONTROL_PORT + Number(workerId);
    this.dataDir = `/tmp/lll-tor-w${workerId}`;
    this.cookieFile = path.join(this.dataDir, "control_auth_cookie");
    this.child = null;
    this.generation = 0;
    this.exitIp = null;
    this.ready = false;
  }

  socksUrl() {
    return `socks5://127.0.0.1:${this.port}`;
  }

  isRunning() {
    return Boolean(this.child && this.child.exitCode == null);
  }

  async killPortListener(port) {
    const pids = [];
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(
        "lsof",
        [`-tiTCP:${port}`, "-sTCP:LISTEN"],
        { encoding: "utf8" }
      );
      for (const rawPid of String(stdout).trim().split(/\s+/)) {
        const pid = Number(rawPid);
        if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
          pids.push(pid);
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Listener exited between lsof and kill.
          }
        }
      }
    } catch {
      // No listener (lsof exits 1) or lsof is unavailable.
    }
    if (!pids.length) {
      return;
    }
    const deadline = Date.now() + 2_000;
    while (
      Date.now() < deadline &&
      (await portOpen("127.0.0.1", port, 200))
    ) {
      await sleep(100);
    }
    if (await portOpen("127.0.0.1", port, 200)) {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Listener already exited.
        }
      }
      await sleep(200);
    }
  }

  async stop() {
    if (this.exitIp) {
      await releaseExitIp(this.workerId, this.exitIp).catch(() => {});
      this.exitIp = null;
    }

    const child = this.child;
    this.child = null;
    this.ready = false;

    if (child && child.exitCode == null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      await Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        sleep(2_000)
      ]);
      try {
        if (child.exitCode == null) {
          child.kill("SIGKILL");
        }
      } catch {
        // ignore
      }
    }

    // Clear orphans left when a prior worker was SIGKILLed.
    await Promise.all([
      this.killPortListener(this.port),
      this.killPortListener(this.controlPort)
    ]);
  }

  async probeExitIp() {
    const endpoints = [
      "https://api.ipify.org",
      "https://ifconfig.me/ip",
      "https://icanhazip.com"
    ];
    for (const url of endpoints) {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync(
          "curl",
          [
            "-sS",
            "--max-time",
            "10",
            "--socks5-hostname",
            `127.0.0.1:${this.port}`,
            url
          ],
          { encoding: "utf8" }
        );
        const ip = String(stdout).trim().split(/\s+/)[0];
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
          return ip;
        }
      } catch {
        // Try the next independent IP service.
      }
    }
    return null;
  }

  async sendControl(command) {
    const cookie = await fs.readFile(this.cookieFile);
    const auth = cookie.toString("hex");
    return new Promise((resolve, reject) => {
      const socket = net.connect(
        { host: "127.0.0.1", port: this.controlPort },
        () => {
          socket.write(
            `AUTHENTICATE ${auth}\r\n${command}\r\nQUIT\r\n`
          );
        }
      );
      let response = "";
      let settled = false;
      const finish = error => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      };
      socket.setEncoding("utf8");
      socket.setTimeout(5_000, () =>
        finish(new Error(`Tor control timeout on ${this.controlPort}`))
      );
      socket.on("data", chunk => {
        response += chunk;
        if (/^5\d\d[ -]/m.test(response)) {
          finish(
            new Error(
              `Tor control rejected ${command}: ${response.trim().slice(0, 160)}`
            )
          );
        } else if (/250 closing connection/i.test(response)) {
          finish();
        }
      });
      socket.on("error", finish);
      socket.on("end", () => finish());
    });
  }

  async startDaemon() {
    if (
      this.isRunning() &&
      this.ready &&
      (await portOpen("127.0.0.1", this.port, 500))
    ) {
      return;
    }

    await this.stop();
    await fs.mkdir(this.dataDir, { recursive: true });

    const torBin =
      process.env.TOR_BIN ??
      (await fs
        .access("/opt/homebrew/bin/tor")
        .then(() => "/opt/homebrew/bin/tor")
        .catch(() => "tor"));

    log(
      `Starting persistent Tor socks=127.0.0.1:${this.port} control=127.0.0.1:${this.controlPort}`
    );

    let bootstrapped = false;
    let lastBootLog = "";
    const child = spawnProcess(
      torBin,
      [
        "--SocksPort",
        `127.0.0.1:${this.port} IsolateSOCKSAuth`,
        "--ControlPort",
        `127.0.0.1:${this.controlPort}`,
        "--CookieAuthentication",
        "1",
        "--CookieAuthFile",
        this.cookieFile,
        "--DataDirectory",
        this.dataDir,
        "--ClientOnly",
        "1",
        "--AvoidDiskWrites",
        "1",
        "--MaxCircuitDirtiness",
        "30",
        "--NewCircuitPeriod",
        "10",
        "--Log",
        "notice stdout"
      ],
      {
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    this.child = child;
    let spawnError = null;

    const onTorLog = chunk => {
      const text = String(chunk);
      lastBootLog = text;
      if (/Bootstrapped 100%/i.test(text)) {
        bootstrapped = true;
      }
      const notice = text.trim();
      if (notice && /Bootstrapped|error|warn/i.test(notice)) {
        log(`tor: ${notice.slice(0, 160)}`);
      }
    };

    child.stdout.on("data", onTorLog);
    child.stderr.on("data", onTorLog);
    child.on("error", error => {
      spawnError = error;
    });
    child.on("exit", code => {
      if (this.child === child) {
        this.ready = false;
      }
      log(`Tor exited code=${code}`);
    });

    const deadline = Date.now() + TOR_BOOTSTRAP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const socksReady = await portOpen("127.0.0.1", this.port, 500);
      const controlReady = await portOpen(
        "127.0.0.1",
        this.controlPort,
        500
      );
      if (socksReady && controlReady && bootstrapped) {
        this.ready = true;
        return;
      }
      if (child.exitCode != null) {
        throw new Error(
          `Tor died during bootstrap (code ${child.exitCode}) ${lastBootLog.slice(0, 100)}`
        );
      }
      if (spawnError) {
        throw new Error(`Could not start Tor: ${spawnError.message}`);
      }
      await sleep(500);
    }

    await this.stop();
    throw new Error(`Tor failed to bootstrap on ${this.port}`);
  }

  async newIdentity() {
    await this.sendControl("SIGNAL NEWNYM");
    this.generation += 1;
    log(
      `Tor NEWNYM gen=${this.generation}; waiting ${TOR_NEWNYM_WAIT_MS}ms`
    );
    await sleep(TOR_NEWNYM_WAIT_MS);
  }

  async startFresh() {
    await this.startDaemon();
    const previousExitIp = this.exitIp;

    // Keep the daemon and consensus cache alive; rotate only its circuits.
    for (let tryN = 1; tryN <= 6; tryN++) {
      if (previousExitIp || tryN > 1) {
        await this.newIdentity();
      }

      const exitIp = await this.probeExitIp();
      if (!exitIp) {
        log(`Tor exit IP probe failed (try ${tryN}/6)`);
        continue;
      }
      if (previousExitIp && exitIp === previousExitIp) {
        log(`Tor NEWNYM kept exit=${exitIp} (try ${tryN}/6)`);
        continue;
      }

      const claimed = await claimExitIp(this.workerId, exitIp);
      if (claimed) {
        this.exitIp = exitIp;
        log(`Tor ready on ${this.port} exit=${exitIp}`);
        return this.socksUrl();
      }

      log(
        `Tor exit ${exitIp} already used by another worker (try ${tryN}/6)`
      );
    }

    throw new Error(
      `Tor could not obtain a fresh unique exit on ${this.port}`
    );
  }
}

async function probeExitIpViaPage(page) {
  return page
    .evaluate(async () => {
      const endpoints = [
        "https://api.ipify.org",
        "https://ifconfig.me/ip",
        "https://icanhazip.com"
      ];
      for (const url of endpoints) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
          const res = await fetch(url, {
            cache: "no-store",
            signal: controller.signal
          });
          const text = (await res.text()).trim().split(/\s+/)[0];
          if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
            return text;
          }
        } catch {
          // next
        } finally {
          clearTimeout(timer);
        }
      }
      return null;
    })
    .catch(() => null);
}

async function ensureUniqueExitIp(page, workerTor) {
  if (!workerTor) {
    return true;
  }
  // WorkerTor verifies and claims the same SOCKS exit before Chrome starts.
  if (workerTor.exitIp) {
    return true;
  }
  const ip = await probeExitIpViaPage(page);
  if (!ip) {
    log("Browser exit IP probe failed — continuing");
    return true;
  }
  const claimed = await claimExitIp(WORKER_ID, ip);
  if (claimed) {
    workerTor.exitIp = ip;
    log(`Browser exit IP=${ip} (unique)`);
    return true;
  }
  log(`Browser exit IP=${ip} collides with another worker`);
  return false;
}

async function withExitRegistryLock(fn) {
  return withFileLock(`${EXIT_IP_REGISTRY}.lock`, fn, {
    timeoutMs: 8_000,
    staleMs: 15_000
  });
}

async function readExitRegistry() {
  try {
    const raw = await fs.readFile(EXIT_IP_REGISTRY, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function writeExitRegistry(data) {
  await atomicWriteFile(
    EXIT_IP_REGISTRY,
    JSON.stringify(data, null, 2)
  );
}

async function claimExitIp(workerId, ip) {
  return withExitRegistryLock(async () => {
    const data = await readExitRegistry();
    const now = Date.now();
    const wid = String(workerId);
    for (const [otherIp, meta] of Object.entries(data)) {
      const age = now - (meta?.at || 0);
      let ownerAlive = false;
      const ownerPid = Number(meta?.pid);
      if (Number.isInteger(ownerPid) && ownerPid > 1) {
        try {
          process.kill(ownerPid, 0);
          ownerAlive = true;
        } catch {
          ownerAlive = false;
        }
      }
      const stale =
        !meta ||
        (meta.pid
          ? (!ownerAlive && age > 2 * 60_000) ||
            age > 24 * 60 * 60_000
          : age > 20 * 60_000);
      if (stale) {
        delete data[otherIp];
        continue;
      }
      // One exit per worker — drop this worker's previous claim.
      if (String(meta.workerId) === wid && otherIp !== ip) {
        delete data[otherIp];
      }
    }
    const owner = data[ip];
    if (owner && String(owner.workerId) !== wid) {
      await writeExitRegistry(data);
      return false;
    }
    data[ip] = { workerId: wid, pid: process.pid, at: now };
    await writeExitRegistry(data);
    return true;
  });
}

async function releaseExitIp(workerId, ip) {
  return withExitRegistryLock(async () => {
    const data = await readExitRegistry();
    const wid = String(workerId);
    let changed = false;
    for (const [otherIp, meta] of Object.entries(data)) {
      if (!meta) {
        delete data[otherIp];
        changed = true;
        continue;
      }
      if (String(meta.workerId) === wid || (ip && otherIp === ip)) {
        delete data[otherIp];
        changed = true;
      }
    }
    if (changed) {
      await writeExitRegistry(data);
    }
  });
}

async function loadProxyList() {
  try {
    const raw = await fs.readFile(PROXY_LIST_FILE, "utf8");
    return raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function parseProxyUrl(raw) {
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  const server = `${url.protocol}//${url.hostname}${
    url.port ? `:${url.port}` : ""
  }`;
  const proxy = { server };
  if (url.username) {
    proxy.username = decodeURIComponent(url.username);
  }
  if (url.password) {
    proxy.password = decodeURIComponent(url.password);
  }
  return proxy;
}

class ProxyRotator {
  constructor({ mode, list, workerTor }) {
    this.mode = mode;
    this.list = list;
    this.workerTor = workerTor;
    this.index = Number(WORKER_ID) % Math.max(list.length, 1);
    this.circuit = 0;
    this.lastListReloadAt = 0;
  }

  async maybeReloadList() {
    if (this.mode !== "list") {
      return;
    }
    // ProxyScrape refreshes ~every minute; pick up new exits without restart.
    if (Date.now() - this.lastListReloadAt < 60_000) {
      return;
    }
    this.lastListReloadAt = Date.now();
    const fresh = await loadProxyList();
    if (fresh.length) {
      const prev = this.list.length;
      this.list = fresh;
      if (this.index >= this.list.length) {
        this.index = Number(WORKER_ID) % this.list.length;
      }
      if (fresh.length !== prev) {
        log(`Proxy list reloaded: ${prev} → ${fresh.length}`);
      }
    }
  }

  async next() {
    this.circuit += 1;
    await this.maybeReloadList();

    if (this.mode === "tor") {
      // Dedicated Tor per worker — Chrome cannot do SOCKS5 auth.
      const server = this.workerTor
        ? await this.workerTor.startFresh()
        : TOR_SOCKS || "socks5://127.0.0.1:9050";
      return {
        server,
        label: `tor#${this.circuit} ${server}`
      };
    }

    if (this.mode === "list" && this.list.length) {
      const raw = this.list[this.index % this.list.length];
      this.index += 1;
      const proxy = parseProxyUrl(raw);
      return {
        ...proxy,
        label: `list#${this.index} ${proxy.server}`
      };
    }

    return null;
  }
}

function findRecordArray(value, depth = 0) {
  if (depth > 6) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  for (const key of [
    "words",
    "results",
    "items",
    "data"
  ]) {
    if (!(key in value)) {
      continue;
    }

    const result = findRecordArray(
      value[key],
      depth + 1
    );

    if (result.length > 0 || Array.isArray(value[key])) {
      return result;
    }
  }

  for (const child of Object.values(value)) {
    const result = findRecordArray(
      child,
      depth + 1
    );

    if (result.length > 0) {
      return result;
    }
  }

  return [];
}

function extractWord(record) {
  if (typeof record === "string") {
    return record.trim().toLowerCase();
  }

  if (!record || typeof record !== "object") {
    return null;
  }

  const candidate =
    record.word ??
    record.name ??
    record.text ??
    record.value ??
    null;

  return typeof candidate === "string"
    ? candidate.trim().toLowerCase()
    : null;
}

function firstRootLetter() {
  return LETTERS[0] ?? null;
}

function nextRootLetter(completed) {
  for (const letter of LETTERS) {
    if (!completed.has(letter)) {
      return letter;
    }
  }
  return null;
}

function nextCharAfterPrefix(word, prefix) {
  if (typeof word !== "string" || !word.startsWith(prefix)) {
    return null;
  }
  if (word.length <= prefix.length) {
    return null;
  }
  return word[prefix.length];
}

/**
 * Full page (LIMIT hits) ⇒ results are alphabetical.
 * Every next-letter group strictly before the last hit is complete — skip it.
 * Continue from the last group's character through the rest of ALPHABET
 * (later letters were never reached because the page filled up).
 */
function planChildrenFromFullPage(prefix, pageWords) {
  const sorted = [...pageWords].filter(Boolean).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );

  if (!sorted.length) {
    return {
      children: [...ALPHABET].map(c => prefix + c),
      skipped: [],
      lastNext: null,
      exactWord: false
    };
  }

  const exactWord = sorted.some(w => w === prefix);
  const lastWord = sorted[sorted.length - 1];
  const lastNext = nextCharAfterPrefix(lastWord, prefix);

  // Last row is the exact prefix ⇒ longer words still exist after it.
  if (!lastNext) {
    return {
      children: [...ALPHABET].map(c => prefix + c),
      skipped: [],
      lastNext: null,
      exactWord
    };
  }

  const children = [];
  const skipped = [];
  for (const character of ALPHABET) {
    // JS/Unicode code-unit order matches typical API lexicographic order
    // (' and - sort before a–z).
    if (character < lastNext) {
      skipped.push(prefix + character);
    } else {
      children.push(prefix + character);
    }
  }

  return { children, skipped, lastNext, exactWord, lastWord };
}

/**
 * Reverse (Z→A) full-page planner.
 *
 * A desc-sorted full page lists from the alphabetically-latest group down to
 * the earliest group still on the page.
 *
 * Default (cleanup): everything in that span is covered EXCEPT the
 * reverse-start group (latest next-char, e.g. "z"), which stays queued.
 * Example: reverse "can" ends at "cantoned" (next='t'), starts in 'z' →
 * skip cant..cany, leave only canz.
 *
 * keepBothExtremes=true (main scrapers): leave BOTH span endpoints queued and
 * only mark the exclusive middle completed.
 * Example: reverse "arch" spans 'i'..'y' → complete archj..archx; keep archi +
 * archy (and anything outside the span still needed from the forward plan).
 */
function planChildrenFromFullPageReverse(
  prefix,
  pageWords,
  { keepBothExtremes = false } = {}
) {
  const sortedDesc = [...pageWords].filter(Boolean).sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0
  );

  if (!sortedDesc.length) {
    return {
      children: [],
      skipped: [],
      lastNext: null,
      firstNext: null,
      exactWord: false
    };
  }

  const exactWord = sortedDesc.some(w => w === prefix);
  const firstWord = sortedDesc[0];
  const lastWord = sortedDesc[sortedDesc.length - 1];
  const firstNext = nextCharAfterPrefix(firstWord, prefix);
  const lastNext = nextCharAfterPrefix(lastWord, prefix);

  // Page ends on the exact prefix word — no stable next-char boundary.
  if (!lastNext || !firstNext) {
    const children = [];
    if (firstNext) {
      children.push(prefix + firstNext);
    }
    if (
      keepBothExtremes &&
      lastNext &&
      lastNext !== firstNext
    ) {
      children.push(prefix + lastNext);
    }
    return {
      children,
      skipped: [],
      lastNext,
      firstNext,
      exactWord,
      lastWord,
      firstWord
    };
  }

  const lo = ALPHABET.indexOf(lastNext);
  const hi = ALPHABET.indexOf(firstNext);
  const children = [];
  const skipped = [];

  if (lo < 0 || hi < 0) {
    // Unexpected char outside ALPHABET — keep reverse-start (and low end if asked).
    children.push(prefix + firstNext);
    if (keepBothExtremes && lastNext !== firstNext) {
      children.push(prefix + lastNext);
    }
    return {
      children,
      skipped,
      lastNext,
      firstNext,
      exactWord,
      lastWord,
      firstWord
    };
  }

  const from = Math.min(lo, hi);
  const to = Math.max(lo, hi);
  for (let i = from; i <= to; i++) {
    const character = ALPHABET[i];
    const child = prefix + character;
    const isHigh = character === firstNext;
    const isLow = character === lastNext;
    if (isHigh || (keepBothExtremes && isLow)) {
      children.push(child);
    } else {
      skipped.push(child);
    }
  }

  return {
    children,
    skipped,
    lastNext,
    firstNext,
    exactWord,
    lastWord,
    firstWord
  };
}

/** Same payload as clicking A-Z → Z-A in the Custom Search UI. */
const REVERSE_SORT = [{ type: "alphabetical", direction: "desc" }];

/**
 * Merge forward A→Z coverage with reverse Z→A coverage for a full page.
 *
 * Forward already completed groups before fwdLastNext and queued the rest.
 * Reverse exclusive-middle groups (between its low/high extremes) are also
 * completed. Queue keeps [fwdLastNext .. revLow] ∪ [revHigh .. end].
 */
function mergeForwardAndReversePlans(forwardPlan, reversePlan) {
  const reverseSkipped = new Set(reversePlan.skipped);
  const skipped = [
    ...forwardPlan.skipped,
    ...reversePlan.skipped.filter(p => !forwardPlan.skipped.includes(p))
  ];
  const children = forwardPlan.children.filter(p => !reverseSkipped.has(p));
  return { skipped, children };
}

/** Shortest prefixes first, then A→Z within the same length. */
function sortQueueShortestFirst(queue) {
  queue.sort((a, b) =>
    a.length !== b.length ? a.length - b.length : a.localeCompare(b)
  );
}


async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const state = JSON.parse(raw);

    const queue = Array.isArray(state.queue) ? state.queue : [];
    sortQueueShortestFirst(queue);
    return {
      queue,
      completed: new Set(
        Array.isArray(state.completed)
          ? state.completed
          : []
      ),
      words: new Set(
        Array.isArray(state.words) ? state.words : []
      )
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    if (!LETTERS) {
      throw new Error("LETTERS env var is empty");
    }

    const first = firstRootLetter();
    return {
      // One root at a time — finish a's whole tree before b.
      queue: first ? [first] : [],
      completed: new Set(),
      words: new Set()
    };
  }
}

async function mergeSharedOutput() {
  return withFileLock(`${SHARED_OUTPUT_FILE}.lock`, async () => {
    const dir = process.cwd();
    const entries = await fs.readdir(dir);
    const workerFiles = entries
      .filter(name => /^last-\d+\.txt$/.test(name))
      .sort();

    const words = new Set();

    for (const name of workerFiles) {
      try {
        const raw = await fs.readFile(
          path.join(dir, name),
          "utf8"
        );

        for (const line of raw.split(/\r?\n/)) {
          const word = line.trim().toLowerCase();
          if (word) {
            words.add(word);
          }
        }
      } catch {
        // Ignore files that disappear between readdir and read.
      }
    }

    await atomicWriteFile(
      SHARED_OUTPUT_FILE,
      [...words].sort((a, b) => a.localeCompare(b)).join("\n") +
        (words.size ? "\n" : "")
    );

    return words.size;
  });
}

async function appendSharedWords(newWords) {
  if (!newWords?.length) {
    return;
  }
  // Cheap incremental append — full sorted merge is periodic only.
  await fs.appendFile(
    SHARED_OUTPUT_FILE,
    newWords.join("\n") + "\n",
    "utf8"
  );
}

async function saveState({ queue, completed, words, newWords = [] }) {
  sortQueueShortestFirst(queue);
  const state = {
    workerId: WORKER_ID,
    letters: LETTERS,
    libraryMode: LIBRARY_MODE,
    queue,
    completed: [...completed],
    words: [...words]
  };

  // State + per-worker file every search (needed for crash resume).
  await Promise.all([
    atomicWriteFile(STATE_FILE, JSON.stringify(state)),
    atomicWriteFile(
      OUTPUT_FILE,
      [...words]
        .sort((a, b) => a.localeCompare(b))
        .join("\n") + (words.size ? "\n" : "")
    )
  ]);

  await appendSharedWords(newWords).catch(() => {});

  savesSinceMerge += 1;
  let total = null;
  if (savesSinceMerge >= MERGE_EVERY_N) {
    savesSinceMerge = 0;
    total = await mergeSharedOutput().catch(() => null);
  }

  log(
    `Saved ${words.size.toLocaleString()} worker words` +
      (total != null
        ? `; shared ${SHARED_OUTPUT_FILE} now ${total.toLocaleString()}`
        : "")
  );
}

/**
 * Light pointer nudge — only used after a mint miss.
 * Successful managed remints don't need the slow mouse theater.
 */
function isClosedTargetError(error) {
  const message = String(error?.message ?? error ?? "");
  return /Target page, context or browser has been closed|Browser has been closed|Target closed|Execution context was destroyed|Protocol error.*Session closed/i.test(
    message
  );
}

async function interactWithTurnstile(page, { thorough = false } = {}) {
  try {
  const widget = page
    .locator(
      ".cf-turnstile, [data-sitekey], iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile'], #lll-audit-turnstile"
    )
    .first();

  if (!(await widget.count().catch(() => 0))) {
    if (!thorough) {
      return false;
    }
    const viewport = page.viewportSize() ?? {
      width: 1280,
      height: 900
    };
    await page.mouse.move(
      rand(80, viewport.width - 80),
      rand(80, viewport.height - 80),
      { steps: 4 }
    ).catch(() => {});
    await sleep(40);
    return false;
  }

  const box = await widget.boundingBox().catch(() => null);
  if (!box) {
    return false;
  }

  const x = box.x + box.width * rand(0.35, 0.65);
  const y = box.y + box.height * rand(0.35, 0.65);
  await page.mouse.move(x, y, { steps: thorough ? 6 : 2 }).catch(() => {});
  if (thorough) {
    await sleep(rand(40, 90));
    try {
      const btn = page
        .locator(".cf-turnstile-button, input[type='checkbox']")
        .first();
      if (await btn.count()) {
        await btn.click({ timeout: 400 }).catch(() => {});
      } else {
        await page.mouse.click(x, y).catch(() => {});
      }
    } catch {
      // ignore
    }
    await sleep(rand(60, 120));
  }
  return true;
  } catch (error) {
    if (isClosedTargetError(error)) {
      return false;
    }
    throw error;
  }
}

async function clearClientSearchCooldown(page) {
  // Site UI gates button clicks with localStorage lastLetterSearchTime (15s).
  await page
    .evaluate(() => {
      try {
        localStorage.setItem(
          "lastLetterSearchTime",
          String(Date.now() - 60_000)
        );
      } catch {
        // ignore
      }
    })
    .catch(() => {});
}

async function ensureProMode(page, { quiet = false } = {}) {
  if (page._lllProReady && LIBRARY_MODE === "pro") {
    return;
  }
  if (page._lllCasualReady && LIBRARY_MODE !== "pro") {
    return;
  }

  if (LIBRARY_MODE !== "pro") {
    const casual = page
      .locator("button.library-mode-option", { hasText: /^Casual$/i })
      .first();
    if (await casual.count()) {
      const pressed = await casual.getAttribute("aria-pressed");
      if (pressed !== "true") {
        await casual.click({ force: true }).catch(() => {});
        await sleep(FAST_MODE ? 80 : 300);
      }
    }
    page._lllCasualReady = true;
    if (!quiet) {
      log("Library mode=casual");
    }
    return;
  }

  const pro = page
    .locator("button.library-mode-option", { hasText: /^Pro$/i })
    .first();

  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await pro.waitFor({ state: "visible", timeout: 15_000 });
      const pressed = await pro.getAttribute("aria-pressed");
      const active = await pro
        .evaluate(el => el.classList.contains("is-active"))
        .catch(() => false);

      if (pressed === "true" || active) {
        page._lllProReady = true;
        if (!quiet) {
          log("Library mode=pro");
        }
        return;
      }

      await pro.click({ force: true });
      await sleep(FAST_MODE ? 120 : 400);

      const nowPressed = await pro.getAttribute("aria-pressed");
      const nowActive = await pro
        .evaluate(el => el.classList.contains("is-active"))
        .catch(() => false);
      if (nowPressed === "true" || nowActive) {
        page._lllProReady = true;
        if (!quiet) {
          log("Library mode=pro");
        }
        return;
      }
    } catch (error) {
      if (attempt === 6) {
        throw new Error(
          `Could not enable Pro mode: ${error.message.slice(0, 120)}`
        );
      }
      await sleep(FAST_MODE ? 250 : 800);
    }
  }

  throw new Error("Could not enable Pro mode");
}

async function ensureCustomSearch(page) {
  const startsWith = page.getByPlaceholder(/e\.g\.\s*qu/i);

  // Fast path: panel already open — skip tab / Clear / Pro dance.
  if (
    page._lllCustomOpen &&
    (await startsWith.first().isVisible().catch(() => false))
  ) {
    await ensureProMode(page, { quiet: true });
    return startsWith.first();
  }

  await ensureProMode(page);
  const tab = page.locator('[data-testid="tab-custom-search"]');
  const pause = FAST_MODE ? 120 : 500;

  for (let attempt = 1; attempt <= 8; attempt++) {
    await page.keyboard.press("Escape").catch(() => {});

    const clear = page.getByRole("button", {
      name: /^Clear$/i
    });
    if (await clear.count()) {
      await clear.first().click().catch(() => {});
      await sleep(pause);
    }

    await ensureProMode(page, { quiet: true });

    try {
      await tab.first().waitFor({
        state: "visible",
        timeout: 20_000
      });
      await tab.first().click({ force: true });
      await sleep(pause);

      if (!(await startsWith.first().isVisible().catch(() => false))) {
        await tab.first().click({ force: true });
        await sleep(pause);
      }
    } catch {
      const customSearch = page.getByRole("button", {
        name: /^Custom Search$/i
      });
      if (await customSearch.count()) {
        await customSearch.first().click({ force: true });
        await sleep(pause);
      }
    }

    try {
      await startsWith.first().waitFor({
        state: "visible",
        timeout: 12_000
      });
      await ensureProMode(page, { quiet: true });
      page._lllCustomOpen = true;
      return startsWith.first();
    } catch (error) {
      page._lllCustomOpen = false;
      if (attempt === 8) {
        throw error;
      }

      log(
        `Custom Search panel missing (attempt ${attempt}); retrying`
      );

      if (attempt % 3 === 0) {
        page._lllProReady = false;
        await page.reload({
          waitUntil: "domcontentloaded",
          timeout: 60_000
        });
        await sleep(FAST_MODE ? 600 : 1_500);
        await ensureProMode(page);
      } else {
        await sleep(FAST_MODE ? 400 : 1_000);
      }
    }
  }

  throw new Error("Could not open Custom Search panel");
}

async function waitForSearchEnabled(page) {
  const submit = page
    .locator("button.w-full")
    .filter({
      hasText: /fortified search|search|find|go|submit|verifying|wait\s*\d+s/i
    })
    .first();

  await submit.waitFor({ state: "visible", timeout: 60_000 });

  const deadline = Date.now() + 120_000;
  let verifyingSince = 0;
  let lastInteract = 0;
  let reloadCount = 0;

  while (Date.now() < deadline) {
    const text = ((await submit.textContent()) || "").trim();
    const enabled = await submit.isEnabled().catch(() => false);
    const waiting = /verifying|wait\s*\d+s/i.test(text);

    const fortified = /fortified search/i.test(text);
    if ((enabled && !waiting) || (fortified && !/verifying/i.test(text))) {
      if (!enabled) {
        await sleep(400);
      }
      const nowEnabled = await submit.isEnabled().catch(() => false);
      if (nowEnabled || fortified) {
        log(`Custom Search ready (${text || "enabled"})`);
        return submit;
      }
    }

    if (/verifying/i.test(text)) {
      if (!verifyingSince) {
        verifyingSince = Date.now();
      }

      // Fast path: don't sit in Verifying loops — nudge once, then rotate.
      if (Date.now() - lastInteract > 5_000) {
        await interactWithTurnstile(page);
        lastInteract = Date.now();
      }

      if (Date.now() - verifyingSince > 25_000) {
        reloadCount += 1;
        if (reloadCount >= 2) {
          throw new Error(
            "Turnstile stuck on Verifying Browser — rotate IP"
          );
        }
        log("Turnstile verifying >25s — quick reload then continue");
        await page.reload({
          waitUntil: "domcontentloaded",
          timeout: 60_000
        });
        await sleep(800);
        await ensureProMode(page);
        await interactWithTurnstile(page);
        await ensureCustomSearch(page);
        verifyingSince = Date.now();
        await submit.waitFor({
          state: "visible",
          timeout: 60_000
        }).catch(() => {});
      } else {
        log(`Cooldown/Turnstile: ${text}`);
      }
    } else if (waiting) {
      verifyingSince = 0;
      // Site Wait Ns… is client-only. Clear storage (helps after reload)
      // and sleep the remaining seconds instead of 800ms poll spam.
      await clearClientSearchCooldown(page);
      const waitMatch = text.match(/wait\s*(\d+)\s*s/i);
      const secs = waitMatch ? Number(waitMatch[1]) : 0;
      if (secs > 0) {
        log(`Cooldown/Turnstile: ${text}`);
        await sleep(Math.min(secs, 16) * 1000 + 150);
        continue;
      }
      log(`Cooldown/Turnstile: ${text}`);
    } else {
      verifyingSince = 0;
    }

    await sleep(FAST_MODE ? 250 : 800);
  }

  throw new Error(
    "Custom Search stayed blocked on Turnstile / cooldown"
  );
}

async function waitForTurnstileToken(
  page,
  { timeoutMs = 90_000, previousToken = "" } = {}
) {
  const tokenInput = page.locator(
    'input[name="cf-turnstile-response"]'
  ).first();

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await tokenInput.inputValue().catch(() => "");
    if (
      value &&
      value.length > 20 &&
      value !== previousToken
    ) {
      log(`Turnstile token present (len=${value.length})`);
      return value;
    }
    await sleep(250);
  }

  throw new Error("Timed out waiting for cf-turnstile-response token");
}

// Site Turnstile key (from lastletterlibrary.com bundle).
const TURNSTILE_SITEKEY = "0x4AAAAAACr09WvFR-JJAZaD";

async function readTurnstileToken(page) {
  return page
    .locator('input[name="cf-turnstile-response"]')
    .first()
    .inputValue()
    .catch(() => "");
}

function createMintAttempt(page) {
  const attempt = {
    id: Number(page._lllMintSequence || 0) + 1,
    cancelled: false
  };
  page._lllMintSequence = attempt.id;
  page._lllMintAttempt = attempt;
  return attempt;
}

async function cancelMintAttempt(page, attempt) {
  attempt.cancelled = true;
  if (page._lllMintAttempt === attempt) {
    page._lllMintAttempt = null;
  }
  await page
    .evaluate(attemptId => {
      if (window.__lllTsGeneration === attemptId) {
        window.__lllTsGeneration = attemptId + 1;
        window.__lllTsToken = "";
      }
      const host = document.getElementById("lll-audit-turnstile");
      if (host?.dataset.widgetId && window.turnstile) {
        try {
          window.turnstile.remove(host.dataset.widgetId);
        } catch {
          // Widget may already have been removed during navigation.
        }
      }
      host?.remove();
      document
        .querySelectorAll('input[name="cf-turnstile-response"]')
        .forEach(input => {
          input.value = "";
        });
    }, attempt.id)
    .catch(() => {});
}

/**
 * Mint via a managed Turnstile widget.
 * A consumed widget is remounted by default; repeated reset() calls were the
 * main source of 22s stalls. TURNSTILE_REMOUNT_EVERY can opt into reuse.
 * Does not forge tokens — still a real Cloudflare challenge.
 */
async function mintViaManagedWidget(
  page,
  {
    timeoutMs = 15_000,
    allowSiteFallback = false,
    forceRemount = false,
    nudge = false,
    silent = false,
    attempt
  } = {}
) {
  const t0 = Date.now();
  const ready = await page
    .evaluate(async () => {
      if (window.turnstile?.render) {
        return true;
      }
      await new Promise(resolve => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (window.turnstile?.render || Date.now() - started > 4_000) {
            clearInterval(timer);
            resolve();
          }
        }, 50);
      });
      return Boolean(window.turnstile?.render);
    })
    .catch(() => false);

  if (!ready || attempt?.cancelled) {
    return null;
  }

  if (nudge) {
    await interactWithTurnstile(page, { thorough: true });
  }

  const remountEvery = Math.max(
    1,
    Number(process.env.TURNSTILE_REMOUNT_EVERY ?? "1")
  );
  const uses = Number(page._lllTsUses || 0);
  const shouldRemount =
    forceRemount || !page._lllTsReady || uses >= remountEvery;

  const token = await page
    .evaluate(
      async ({ sitekey, timeoutMs, shouldRemount, attemptId }) => {
        const hostId = "lll-audit-turnstile";
        let host = document.getElementById(hostId);
        if (!host) {
          host = document.createElement("div");
          host.id = hostId;
          host.style.cssText =
            "position:fixed;left:8px;bottom:8px;z-index:2147483647;width:300px;height:65px;overflow:hidden;";
          document.body.appendChild(host);
        }
        window.__lllTsGeneration = attemptId;

        const applyInputs = value => {
          if (window.__lllTsGeneration !== attemptId) {
            return;
          }
          document
            .querySelectorAll('input[name="cf-turnstile-response"]')
            .forEach(input => {
              input.value = value;
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
            });
        };

        const mountWidget = mode => {
          try {
            if (host.dataset.widgetId && window.turnstile) {
              try {
                window.turnstile.remove(host.dataset.widgetId);
              } catch {
                // ignore
              }
              host.innerHTML = "";
              delete host.dataset.widgetId;
            }
            const widgetId = window.turnstile.render(host, {
              sitekey,
              theme: "auto",
              ...mode,
              callback: value => {
                if (window.__lllTsGeneration !== attemptId) {
                  return;
                }
                window.__lllTsToken = value || "";
                window.__lllTsAt = Date.now();
                if (value) {
                  applyInputs(value);
                }
              },
              "error-callback": () => {
                if (window.__lllTsGeneration === attemptId) {
                  window.__lllTsErr = Date.now();
                }
              },
              "expired-callback": () => {
                if (window.__lllTsGeneration === attemptId) {
                  window.__lllTsToken = "";
                }
              },
              "timeout-callback": () => {
                if (window.__lllTsGeneration === attemptId) {
                  window.__lllTsErr = Date.now();
                }
              }
            });
            host.dataset.widgetId = String(widgetId);
            if (mode.execution === "execute") {
              try {
                window.turnstile.execute(widgetId);
              } catch {
                // already running
              }
            }
            return widgetId;
          } catch {
            return null;
          }
        };

        const tryRender = modes => {
          for (const mode of modes) {
            const widgetId = mountWidget(mode);
            if (widgetId) {
              return widgetId;
            }
          }
          return null;
        };

        const prevToken = window.__lllTsToken || "";
        window.__lllTsToken = "";
        window.__lllTsErr = 0;

        const renderModes = [
          {
            appearance: "interaction-only",
            execution: "render",
            retry: "auto",
            "retry-interval": 8_000,
            "refresh-expired": "auto",
            "refresh-timeout": "auto"
          },
          { size: "compact", retry: "auto" },
          { size: "invisible", retry: "auto" },
          {
            size: "compact",
            retry: "auto",
            appearance: "interaction-only",
            execution: "execute"
          }
        ];

        if (!shouldRemount && host.dataset.widgetId && window.turnstile) {
          try {
            window.turnstile.reset(host.dataset.widgetId);
          } catch {
            if (!tryRender(renderModes)) {
              return null;
            }
          }
        } else if (!tryRender(renderModes)) {
          return null;
        }

        const deadline = Date.now() + timeoutMs;
        const errAtStart = window.__lllTsErr || 0;
        while (Date.now() < deadline) {
          if (window.__lllTsGeneration !== attemptId) {
            return null;
          }
          const value = window.__lllTsToken || "";
          if (value.length > 20 && value !== prevToken) {
            return value;
          }
          const errAt = window.__lllTsErr || 0;
          if (errAt > errAtStart && Date.now() - errAt > 200) {
            // Challenge errored; bail immediately so the caller can remount/rotate.
            return null;
          }
          await new Promise(r => setTimeout(r, 50));
        }
        return null;
      },
      {
        sitekey: TURNSTILE_SITEKEY,
        timeoutMs,
        shouldRemount,
        attemptId: attempt?.id ?? 0
      }
    )
    .catch(() => null);

  if (attempt?.cancelled) {
    return null;
  }

  if (token && token.length > 20) {
    page._lllTsReady = true;
    page._lllTsUses = shouldRemount ? 1 : uses + 1;
    if (!silent) {
      log(
        `Managed Turnstile token (len=${token.length}, ${Date.now() - t0}ms${shouldRemount ? ", remount" : ", reset"})`
      );
    }
    return token;
  }

  page._lllTsReady = false;
  page._lllTsUses = 0;

  if (!allowSiteFallback) {
    if (Date.now() - t0 > 50 && !silent) {
      log(`Managed Turnstile miss (${Date.now() - t0}ms)`);
    }
    return null;
  }

  if (attempt?.cancelled) {
    return null;
  }
  const previous = await readTurnstileToken(page);
  await page
    .evaluate(() => {
      document
        .querySelectorAll('input[name="cf-turnstile-response"]')
        .forEach(input => {
          input.value = "";
        });
      if (!window.turnstile) {
        return;
      }
      for (const el of document.querySelectorAll(
        ".cf-turnstile, [data-sitekey]"
      )) {
        try {
          window.turnstile.reset(el);
        } catch {
          // ignore
        }
      }
    })
    .catch(() => {});
  if (attempt?.cancelled) {
    return null;
  }
  await interactWithTurnstile(page, { thorough: true });
  if (attempt?.cancelled) {
    return null;
  }
  try {
    const siteToken = await waitForTurnstileToken(page, {
      timeoutMs: 4_000,
      previousToken: previous
    });
    if (siteToken && !silent) {
      log(`Site Turnstile token (${Date.now() - t0}ms)`);
    }
    return siteToken;
  } catch {
    if (!silent) {
      log(`Site Turnstile remint timed out (${Date.now() - t0}ms)`);
    }
    return null;
  }
}

/**
 * Turnstile tokens are single-use. Prefer fast managed remints.
 * A hard Node.js timeout wraps the Playwright call so a hung page
 * evaluate does not wedge the worker forever.
 */
async function mintFreshTurnstileToken(
  page,
  {
    timeoutMs = 15_000,
    allowSiteFallback = false,
    forceRemount = false,
    nudge = false,
    silent = false
  } = {}
) {
  if (page._lllMintInFlight) {
    return page._lllMintInFlight;
  }

  // Site fallback adds another widget reset + interaction + token wait.
  // Every page has exactly one mint in flight. A generation guard cancels
  // stale browser callbacks before another widget can be mounted.
  const hardTimeoutMs = Math.min(
    40_000,
    timeoutMs + (allowSiteFallback ? 10_000 : 5_000)
  );

  const attempt = createMintAttempt(page);
  const operation = (async () => {
    const mintPromise = mintViaManagedWidget(page, {
      timeoutMs,
      allowSiteFallback,
      forceRemount,
      nudge,
      silent,
      attempt
    }).catch(error => {
      if (isClosedTargetError(error)) {
        return null;
      }
      throw error;
    });
    // Keep the rejected branch handled if the timeout wins the race.
    mintPromise.catch(() => {});

    const timeoutMarker = Symbol("mint-timeout");
    const result = await raceWithTimeout(
      mintPromise,
      hardTimeoutMs,
      timeoutMarker
    );
    if (result === timeoutMarker) {
      if (!silent) {
        log(`Turnstile mint hard timeout after ${hardTimeoutMs}ms`);
      }
      page._lllTsReady = false;
      page._lllTsUses = 0;
      await cancelMintAttempt(page, attempt);
      // The in-page generation check normally releases evaluate immediately.
      await Promise.race([
        mintPromise.catch(() => null),
        sleep(1_500)
      ]);
      return null;
    }
    return result;
  })();

  page._lllMintInFlight = operation;
  try {
    return await operation;
  } finally {
    if (page._lllMintInFlight === operation) {
      page._lllMintInFlight = null;
    }
    if (page._lllMintAttempt === attempt) {
      page._lllMintAttempt = null;
    }
  }
}

async function ensureTokenPool(page) {
  if (page._lllNextToken && page._lllNextToken.length > 20) {
    return null;
  }
  if (page._lllNextTokenPromise) {
    return page._lllNextTokenPromise;
  }

  const poolPromise = (async () => {
    try {
      const token = await mintFreshTurnstileToken(page, {
        // Normal remounts finish inside the 15.5s server gap. If they do not,
        // return to the outer reload/NEWNYM recovery instead of spending
        // another 4-10s resetting the already-stuck site widget.
        timeoutMs: 15_000,
        allowSiteFallback: false,
        forceRemount: !page._lllTsReady
      });
      if (token) {
        page._lllNextToken = token;
      }
    } catch (error) {
      if (!isClosedTargetError(error)) {
        throw error;
      }
    }
  })().catch(error => {
    if (!isClosedTargetError(error)) {
      log(`Token pool error: ${String(error?.message ?? error).slice(0, 120)}`);
    }
  }).finally(() => {
    if (page._lllNextTokenPromise === poolPromise) {
      page._lllNextTokenPromise = null;
    }
  });
  page._lllNextTokenPromise = poolPromise;
  return poolPromise;
}

async function takeTokenFromPool(page, maxWaitMs = 35_000) {
  if (page._lllNextToken && page._lllNextToken.length > 20) {
    const token = page._lllNextToken;
    page._lllNextToken = null;
    return token;
  }

  // One bounded attempt per search. The old polling loop started a new mint
  // every time a failed pool promise cleared, causing 90s retry storms.
  const pending =
    page._lllNextTokenPromise || ensureTokenPool(page);
  if (pending) {
    await raceWithTimeout(
      pending.catch(() => {}),
      maxWaitMs,
      null
    );
  }
  if (page._lllNextToken && page._lllNextToken.length > 20) {
    const token = page._lllNextToken;
    page._lllNextToken = null;
    return token;
  }
  return null;
}

async function obtainTurnstileToken(page) {
  // Prefer the pool and let its single mint finish. Starting the next mint
  // before fetch() consumes this token resets the widget and can invalidate
  // the token, producing intermittent 403s and needless Tor rotations.
  const pooled = await takeTokenFromPool(page);
  if (pooled) {
    page._lllTokenConsumed = true;
    return pooled;
  }

  // Compatibility fallback for a site-managed token not captured by the pool.
  const existing = await readTurnstileToken(page);
  if (existing && existing.length > 20 && !page._lllTokenConsumed) {
    page._lllTokenConsumed = true;
    return existing;
  }

  // The caller's reload/rotation policy handles a genuinely bad circuit.
  // Starting another mint here can only overlap an abandoned browser task.
  return null;
}

function prefetchTurnstileToken(page) {
  ensureTokenPool(page);
}

async function waitAdaptiveGap(label = "search") {
  const waitMs = nextSearchAt - Date.now();
  if (waitMs > 50) {
    log(
      `Pacing ${Math.ceil(waitMs / 1000)}s before ${label} (gap=${adaptiveGapMs}ms)`
    );
    await sleep(waitMs);
  }
}

function gapFloorMs() {
  return Number(
    process.env.MIN_GAP_MS ?? (SEARCH_MODE === "direct" ? "15500" : "0")
  );
}

function noteSuccessfulDirectSearch() {
  // Pace from when the request was sent, not when parsing finished —
  // hides saveState / JSON overhead inside the mandatory IP window.
  const floor = gapFloorMs();
  cleanSuccessStreak += 1;
  // Only probe slightly downward after a long clean streak — aggressive
  // decay caused 8s pacing + constant 429 thrash.
  if (cleanSuccessStreak >= 12 && adaptiveGapMs > floor + 500) {
    adaptiveGapMs = Math.max(floor, adaptiveGapMs - 250);
  }
  const gap = Math.max(adaptiveGapMs, floor);
  const anchor = lastRequestAt || Date.now();
  nextSearchAt = anchor + gap;
}

function noteRateLimited(waitMs, elapsedMs = null) {
  cleanSuccessStreak = 0;
  const floor = gapFloorMs();
  const elapsed =
    elapsedMs != null
      ? elapsedMs
      : lastRequestAt
        ? Date.now() - lastRequestAt
        : adaptiveGapMs;
  // Remaining wait + elapsed ≈ true window. Add a small buffer.
  const suggested = Math.max(floor, elapsed + waitMs + 400, waitMs + 400);
  adaptiveGapMs = Math.min(20_000, Math.max(adaptiveGapMs, suggested));
  nextSearchAt = Date.now() + Math.max(waitMs, 500);
  log(`Learned server gap ≈ ${adaptiveGapMs}ms (wait hint ${waitMs}ms)`);
}

async function performSearchDirect({ page, prefix, sort = null }) {
  // Keep Turnstile widget mounted (Custom Search panel) + Pro selected.
  await ensureCustomSearch(page);
  await ensureProMode(page, { quiet: true });

  // Overlap pacing with token mint — true cycle ≈ max(gap, mint), not sum.
  if (!page._lllNextToken && !page._lllNextTokenPromise) {
    prefetchTurnstileToken(page);
  }
  await waitAdaptiveGap(`"${prefix}"`);

  const activeMode = LIBRARY_MODE === "pro" ? "pro" : "casual";
  const sortParam = Array.isArray(sort) && sort.length ? sort : null;

  async function fireOnce() {
    const token = await obtainTurnstileToken(page);
    if (!token) {
      throw new Error("No Turnstile token for direct search");
    }

    lastRequestAt = Date.now();
    const result = await page.evaluate(
      async ({ apiPath, prefix, limit, activeMode, token, sortParam }) => {
        const params = new URLSearchParams();
        params.set("startsWith", prefix);
        params.set("limit", String(limit));
        params.set("activeMode", activeMode);
        if (sortParam) {
          params.set("sort", JSON.stringify(sortParam));
        }
        const url = `${apiPath}?${params}`;
        const t0 = performance.now();
        const res = await fetch(url, {
          credentials: "include",
          headers: {
            "x-turnstile-token": token,
            accept: "application/json"
          }
        });
        const text = await res.text();
        return {
          status: res.status,
          url: res.url || url,
          text,
          ms: Math.round(performance.now() - t0)
        };
      },
      {
        apiPath: API_PATH,
        prefix,
        limit: LIMIT,
        activeMode,
        token,
        sortParam
      }
    );

    // Token is single-use — clear so the next search remints.
    await page
      .evaluate(() => {
        document
          .querySelectorAll('input[name="cf-turnstile-response"]')
          .forEach(input => {
            input.value = "";
          });
      })
      .catch(() => {});

    const sortLabel = sortParam
      ? ` sort=${sortParam.map(s => `${s.type}:${s.direction}`).join(",")}`
      : "";
    log(
      `[api] ${result.status} mode=${activeMode} startsWith=${prefix}${sortLabel} (${result.ms}ms direct)`
    );
    return result;
  }

  let result = await fireOnce();

  // Inline one 429 retry after the server wait — avoids Failed/requeue noise.
  if (result.status === 429) {
    const waitMatch =
      result.text.match(/(\d+)\s*seconds?/i) ||
      result.text.match(/wait\s*(\d+)/i);
    const secs = waitMatch ? Number(waitMatch[1]) : 10;
    const waitMs = (secs + 1) * 1000;
    const elapsed = lastRequestAt ? Date.now() - lastRequestAt : adaptiveGapMs;
    noteRateLimited(waitMs, elapsed);
    log(`Rate limited — inline wait ${waitMs}ms then retry "${prefix}"`);
    prefetchTurnstileToken(page);
    await sleep(waitMs);
    result = await fireOnce();
    if (result.status === 429) {
      const waitMatch2 =
        result.text.match(/(\d+)\s*seconds?/i) ||
        result.text.match(/wait\s*(\d+)/i);
      const secs2 = waitMatch2 ? Number(waitMatch2[1]) : 10;
      noteRateLimited((secs2 + 1) * 1000);
      prefetchTurnstileToken(page);
      throw new Error(
        `API 429 for "${prefix}": wait ${secs2}s — ${result.text.slice(0, 160)}`
      );
    }
  }

  if (result.status === 401 || result.status === 403) {
    const detail =
      result.text.replace(/\s+/g, " ").trim().slice(0, 240) ||
      "empty response body";
    throw new Error(
      `API ${result.status} for "${prefix}": ${detail}`
    );
  }

  if (result.status !== 200 && result.status !== 304) {
    throw new Error(
      `API ${result.status} for "${prefix}": ${result.text.slice(0, 300)}`
    );
  }

  noteSuccessfulDirectSearch();

  // Remint during the server gap (hides Turnstile latency).
  prefetchTurnstileToken(page);

  let payload = null;
  try {
    payload = result.text ? JSON.parse(result.text) : null;
  } catch {
    payload = null;
  }

  if (!payload) {
    throw new Error(
      `Empty/non-JSON body for "${prefix}" (status ${result.status})`
    );
  }

  return {
    records: findRecordArray(payload),
    status: result.status,
    url: result.url
  };
}

async function performSearchUi({ page, prefix }) {
  const definitions = page.getByPlaceholder(/Search for a word/i);
  if (await definitions.count()) {
    await definitions.first().fill("");
  }

  const startsWith = await ensureCustomSearch(page);

  // Mint token while waiting out any leftover UI Wait countdown.
  const mintPromise = mintFreshTurnstileToken(page);
  await waitForSearchEnabled(page);
  await mintPromise;
  await ensureProMode(page, { quiet: true });
  await clearClientSearchCooldown(page);

  const responsePromise = page.waitForResponse(
    response => {
      try {
        const url = new URL(response.url());
        if (url.pathname !== API_PATH) {
          return false;
        }
        if (url.searchParams.get("startsWith") !== prefix) {
          return false;
        }
        if (LIBRARY_MODE === "pro") {
          return url.searchParams.get("activeMode") === "pro";
        }
        return true;
      } catch {
        return false;
      }
    },
    { timeout: 120_000 }
  );

  await startsWith.fill(prefix);

  if (await definitions.count()) {
    await definitions.first().fill("");
  }

  const submit = await waitForSearchEnabled(page);
  log(`Starts With="${prefix}" → submit`);
  await submit.click();

  const response = await responsePromise;
  const status = response.status();
  let payload = null;
  let rawText = "";

  try {
    rawText = await response.text();
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }

  if (status !== 200 && status !== 304) {
    throw new Error(
      `API ${status} for "${prefix}": ${rawText.slice(0, 300)}`
    );
  }

  if (!payload) {
    throw new Error(
      `Empty/non-JSON body for "${prefix}" (status ${status})`
    );
  }

  return {
    records: findRecordArray(payload),
    status,
    url: response.url()
  };
}

async function performSearch({ page, prefix }) {
  if (SEARCH_MODE === "direct") {
    try {
      return await performSearchDirect({ page, prefix });
    } catch (error) {
      const msg = error.message || "";
      // Only fall back to UI if the Custom Search / Turnstile panel is gone.
      // Token misses should retry on the direct path (UI Wait is slower).
      if (/Custom Search panel missing|Could not open Custom Search/i.test(msg)) {
        log(`Direct search failed (${msg.slice(0, 80)}); falling back to UI`);
        return await performSearchUi({ page, prefix });
      }
      throw error;
    }
  }
  return performSearchUi({ page, prefix });
}

async function launchSession({ profileDir, proxy }) {
  if (CDP_URL) {
    log(`Attaching to Chrome at ${CDP_URL}`);
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context =
      browser.contexts()[0] ??
      (await browser.newContext({
        viewport: { width: 1280, height: 900 },
        ...(proxy ? { proxy } : {})
      }));
    return { browser, context, launchedByScript: false };
  }

  // Fresh profile dir per circuit so cookies don't stick to a banned IP.
  log(`Launching persistent Chrome profile ${profileDir}`);
  if (proxy) {
    log(`Proxy ${proxy.label || proxy.server}`);
  }

  await fs.mkdir(profileDir, { recursive: true });

  const launchOptions = {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"
    ]
  };

  if (proxy) {
    launchOptions.proxy = {
      server: proxy.server,
      ...(proxy.username
        ? { username: proxy.username, password: proxy.password || "" }
        : {})
    };
  }

  const context = await chromium.launchPersistentContext(
    profileDir,
    launchOptions
  );

  return { browser: null, context, launchedByScript: true };
}

async function preparePage(context) {
  const page =
    context.pages().find(p =>
      p.url().includes("lastletterlibrary.com")
    ) ??
    context.pages()[0] ??
    (await context.newPage());

  page.removeAllListeners?.("response");
  page.on("response", response => {
    try {
      const url = new URL(response.url());
      if (url.pathname === API_PATH) {
        log(
          `[api] ${response.status()} mode=` +
            `${url.searchParams.get("activeMode") || "?"} startsWith=` +
            `${url.searchParams.get("startsWith")}`
        );
      }
    } catch {
      // ignore
    }
  });

  if (!page.url().includes("lastletterlibrary.com")) {
    log(`Opening ${TARGET_URL}`);
    let lastGotoError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(TARGET_URL, {
          waitUntil: "domcontentloaded",
          timeout: 120_000
        });
        lastGotoError = null;
        break;
      } catch (error) {
        lastGotoError = error;
        log(
          `page.goto failed attempt ${attempt}: ${error.message.slice(0, 120)}`
        );
        await sleep(2_000 * attempt);
      }
    }
    if (lastGotoError) {
      throw lastGotoError;
    }
  } else {
    log(`Reusing tab ${page.url()}`);
  }

  await page
    .locator('[data-testid="tab-custom-search"]')
    .first()
    .waitFor({ state: "visible", timeout: 90_000 })
    .catch(() => {});
  await sleep(1_500);
  await ensureProMode(page);
  page._lllTsReady = false;
  page._lllTsUses = 0;
  page._lllNextToken = null;
  page._lllNextTokenPromise = null;
  page._lllTokenConsumed = false;
  page._lllMintSequence = 0;
  page._lllMintAttempt = null;
  page._lllMintInFlight = null;

  if (MANUAL_TURNSTILE) {
    await interactWithTurnstile(page, { thorough: true });
    log("Pass Turnstile in Chrome, then press Enter here");
    await new Promise(resolve => {
      process.stdin.resume();
      process.stdin.once("data", resolve);
    });
  }

  await ensureCustomSearch(page);
  if (SEARCH_MODE !== "direct") {
    await waitForSearchEnabled(page);
  } else {
    // Direct mode only needs a live Turnstile widget, not Fortified Search.
    const initialToken = await mintFreshTurnstileToken(page, {
      timeoutMs: 18_000,
      allowSiteFallback: true,
      forceRemount: true
    }).catch(() => null);
    if (initialToken) {
      page._lllNextToken = initialToken;
    } else {
      prefetchTurnstileToken(page);
    }
    log(`Search mode=direct (skip UI Wait Ns… gate)`);
  }
  return page;
}

async function wipeProfile(profileDir) {
  await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(profileDir, { recursive: true });
}

async function cleanupOldRotatedProfiles(baseProfile, currentProfileDir) {
  try {
    const dir = path.dirname(baseProfile);
    const baseName = path.basename(baseProfile);
    const entries = await fs.readdir(dir);
    let removed = 0;
    for (const entry of entries) {
      if (
        entry.startsWith(`${baseName}-r`) &&
        path.join(dir, entry) !== currentProfileDir
      ) {
        await fs
          .rm(path.join(dir, entry), { recursive: true, force: true })
          .catch(() => {});
        removed += 1;
      }
    }
    if (removed > 0) {
      log(`Cleaned ${removed} old rotated profile(s)`);
    }
  } catch {
    // ignore
  }
}

async function main() {
  assertAuthorizedTarget(TARGET_URL);
  await acquireWorkerLock();

  if (!LETTERS) {
    throw new Error("Set LETTERS to the roots this worker owns");
  }

  const proxyList = await loadProxyList();
  let mode = PROXY_MODE;
  const workerTor = new WorkerTor(WORKER_ID);

  if (mode === "auto") {
    // Auto is intentionally Tor-only: never silently leak worker traffic
    // through a public proxy list or the machine's direct connection.
    try {
      await fs.access(process.env.TOR_BIN ?? "/opt/homebrew/bin/tor");
      mode = "tor";
    } catch {
      throw new Error(
        "PROXY_MODE=auto requires a local Tor binary; set TOR_BIN if it is installed elsewhere"
      );
    }
  }

  if (REQUIRE_TOR && mode !== "tor") {
    throw new Error(
      `Tor is required for workers (resolved PROXY_MODE=${mode}); set REQUIRE_TOR=0 only for an isolated local test`
    );
  }

  if (mode === "list" && !proxyList.length) {
    throw new Error(
      `PROXY_MODE=list but ${PROXY_LIST_FILE} is empty/missing`
    );
  }

  const rotator = new ProxyRotator({
    mode,
    list: proxyList,
    workerTor: mode === "tor" ? workerTor : null
  });
  log(`IP mode=${mode}${mode === "off" ? " (no proxy)" : ""}`);

  const state = await loadState();
  const queue = state.queue;
  const completed = state.completed;
  const words = state.words;
  const queued = new Set(queue);
  const failures = new Map();

  // Resume: if queue empty but roots remain, enqueue next root.
  if (!queue.length) {
    const next = nextRootLetter(completed);
    if (next) {
      queue.push(next);
      queued.add(next);
    }
  }

  let browser = null;
  let context = null;
  let page = null;
  let launchedByScript = false;
  let proxy = null;
  let rotation = 0;

  const baseProfile =
    process.env.PROFILE_DIR ?? `/tmp/lll-pw-w${WORKER_ID}`;
  let shuttingDown = false;
  const shutdown = async (signal, exitCode = null) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(`Graceful shutdown on ${signal}`);
    await saveState({ queue, completed, words }).catch(() => {});
    if (launchedByScript && context) {
      await context.close().catch(() => {});
    } else if (browser) {
      await browser.close().catch(() => {});
    }
    await workerTor.stop().catch(() => {});
    releaseWorkerLockSync();
    process.exit(
      exitCode ?? (signal === "SIGINT" ? 130 : 143)
    );
  };
  const onSigterm = () => {
    void shutdown("SIGTERM");
  };
  const onSigint = () => {
    void shutdown("SIGINT");
  };
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  // Clean stale rotated profiles left by previous runs or crashes.
  await cleanupOldRotatedProfiles(baseProfile, baseProfile);

  async function openBrowser() {
    if (launchedByScript && context) {
      await context.close().catch(() => {});
    } else if (browser) {
      await browser.close().catch(() => {});
    }

    const profileDir =
      mode === "off"
        ? baseProfile
        : `${baseProfile}-r${rotation}`;

    if (mode !== "off") {
      await wipeProfile(profileDir);
    }

    const session = await launchSession({
      profileDir,
      proxy
    });
    browser = session.browser;
    context = session.context;
    launchedByScript = session.launchedByScript;
    page = await preparePage(context);

    // Prevent old rotated Chrome profiles from filling the disk.
    await cleanupOldRotatedProfiles(baseProfile, profileDir);

    if (mode === "tor") {
      const unique = await ensureUniqueExitIp(page, workerTor);
      if (!unique) {
        throw new Error("EXIT_IP_COLLISION");
      }
    }
  }

  async function rotateIp(reason) {
    // Never throw out of rotate — unattended runs must survive bad exits.
    for (let attempt = 1; attempt <= 8; attempt++) {
      if (shuttingDown) {
        throw new Error("Worker is shutting down");
      }
      try {
        rotation += 1;
        // Drop in-flight Turnstile mint work before closing the page so
        // orphaned mouse.move / remount promises cannot crash the worker.
        if (page) {
          if (page._lllMintAttempt) {
            await cancelMintAttempt(page, page._lllMintAttempt);
          }
          page._lllNextToken = null;
          page._lllNextTokenPromise = null;
          page._lllTokenConsumed = false;
          page._lllMintInFlight = null;
          page._lllTsReady = false;
          page._lllTsUses = 0;
        }
        if (launchedByScript && context) {
          await context.close().catch(() => {});
          context = null;
          page = null;
        } else if (browser) {
          await browser.close().catch(() => {});
          browser = null;
          context = null;
          page = null;
        }

        proxy = mode === "off" ? null : await rotator.next();
        if (shuttingDown) {
          throw new Error("Worker is shutting down");
        }
        log(
          `Rotating IP (#${rotation}, try ${attempt}) after ${reason}` +
            (proxy ? ` → ${proxy.label}` : " → direct")
        );

        const profileDir =
          mode === "off"
            ? baseProfile
            : `${baseProfile}-r${rotation}`;
        if (mode !== "off") {
          await wipeProfile(profileDir);
        }

        const session = await launchSession({
          profileDir,
          proxy
        });
        browser = session.browser;
        context = session.context;
        launchedByScript = session.launchedByScript;
        page = await preparePage(context);

        // Prevent old rotated Chrome profiles from filling the disk.
        await cleanupOldRotatedProfiles(baseProfile, profileDir);

        if (mode === "tor") {
          const unique = await ensureUniqueExitIp(page, workerTor);
          if (!unique) {
            throw new Error("EXIT_IP_COLLISION");
          }
        }
        return;
      } catch (error) {
        if (shuttingDown) {
          throw error;
        }
        log(
          `rotateIp attempt ${attempt} failed: ${error.message.slice(0, 160)}`
        );
        await sleep(2_000 * attempt);
      }
    }
    throw new Error(`rotateIp exhausted after repeated failures (${reason})`);
  }

  if (mode !== "off") {
    proxy = await rotator.next();
  }

  // Launch with many IP rotate retries for flaky Tor exits / Cloudflare.
  for (let launchTry = 1; ; launchTry++) {
    try {
      await openBrowser();
      break;
    } catch (error) {
      log(`Launch failed attempt ${launchTry}: ${error.message.slice(0, 160)}`);
      if (mode === "off" || launchTry >= 20) {
        throw error;
      }
      try {
        await rotateIp(`launch: ${error.message.slice(0, 60)}`);
        break;
      } catch (rotateError) {
        log(`Launch rotate failed: ${rotateError.message.slice(0, 120)}`);
        rotation += 1;
        proxy = mode === "off" ? null : await rotator.next().catch(() => null);
      }
    }
  }

  log(
    `Loaded ${completed.size} prefixes, ${words.size} words; ` +
      `queue=${queue.length}`
  );

  // Track completed searches, not log activity. Mint/rotation logs must not
  // keep a worker alive forever when it makes no queue progress.
  lastProgressAt = Date.now();
  let watchdogFired = false;
  const heartbeat = setInterval(() => {
    const idleMs = Date.now() - lastProgressAt;
    log(
      `heartbeat words=${words.size} queue=${queue.length} rotation=${rotation} idle=${Math.round(idleMs / 1000)}s`
    );
    // Three minutes covers a bounded mint + NEWNYM + retry.
    if (idleMs > 180_000 && !watchdogFired) {
      watchdogFired = true;
      log("No successful search for 180s — respawning worker");
      void shutdown("watchdog", 1);
    }
  }, 60_000);
  if (typeof heartbeat.unref === "function") {
    heartbeat.unref();
  }

  try {
    while (true) {
      if (!queue.length) {
        const next = nextRootLetter(completed);
        if (!next) {
          break;
        }
        queue.push(next);
        queued.add(next);
        log(`Starting next root letter "${next}"`);
      }

      sortQueueShortestFirst(queue);
      const prefix = queue.shift();
      queued.delete(prefix);

      if (completed.has(prefix)) {
        continue;
      }

      log(
        `Searching "${prefix}" | queue=${queue.length} | words=${words.size}`
      );

      try {
        const { records } = await performSearch({
          page,
          prefix
        });

        let recognizedWords = 0;
        const newWords = [];

        for (const record of records) {
          const word = extractWord(record);
          if (!word) {
            continue;
          }
          if (!words.has(word)) {
            newWords.push(word);
          }
          words.add(word);
          recognizedWords++;
        }

        // Exact prefix word (e.g. "fish") is saved when the API returns it —
        // extractWord loop above already adds it; nothing extra required.

        completed.add(prefix);
        failures.delete(prefix);

        log(
          `"${prefix}" → ${records.length} records, ` +
            `${recognizedWords} words` +
            (words.has(prefix) ? ` (incl. exact "${prefix}")` : "")
        );

        // Recursive branch: full page ⇒ forward A→Z covers early groups;
        // reverse Z→A covers exclusive middle of the high span so we only
        // keep [fwdBoundary .. revLow] ∪ [revHigh .. end] in queue.
        if (records.length >= LIMIT) {
          const pageWords = [];
          for (const record of records) {
            const word = extractWord(record);
            if (word) {
              pageWords.push(word);
            }
          }

          const forwardPlan = planChildrenFromFullPage(prefix, pageWords);
          let skippedPrefixes = forwardPlan.skipped;
          let childPrefixes = forwardPlan.children;
          let reverseLog = "";

          try {
            const { records: revRecords } = await performSearchDirect({
              page,
              prefix,
              sort: REVERSE_SORT
            });

            const revPageWords = [];
            let revNew = 0;
            for (const record of revRecords) {
              const word = extractWord(record);
              if (!word) {
                continue;
              }
              revPageWords.push(word);
              if (!words.has(word)) {
                newWords.push(word);
                revNew++;
              }
              words.add(word);
            }

            if (revRecords.length >= LIMIT) {
              const reversePlan = planChildrenFromFullPageReverse(
                prefix,
                revPageWords,
                { keepBothExtremes: true }
              );
              const merged = mergeForwardAndReversePlans(
                forwardPlan,
                reversePlan
              );
              skippedPrefixes = merged.skipped;
              childPrefixes = merged.children;
              reverseLog =
                ` reverse Z→A ends at "${reversePlan.lastWord}" ` +
                `(lo='${reversePlan.lastNext}' hi='${reversePlan.firstNext}'); ` +
                `skip ${reversePlan.skipped.length} middle + ` +
                `${revNew} new words`;
            } else {
              // Reverse page held every remaining word — no children to queue.
              skippedPrefixes = [
                ...new Set([
                  ...forwardPlan.skipped,
                  ...forwardPlan.children
                ])
              ];
              childPrefixes = [];
              reverseLog =
                ` reverse Z→A partial (${revRecords.length}) ` +
                `branch covered (+${revNew} new words)`;
            }
          } catch (revError) {
            log(
              `"${prefix}" reverse search failed ` +
                `(${String(revError.message || revError).slice(0, 80)}); ` +
                `forward-only`
            );
          }

          // Mark fully-covered groups done — never search them.
          for (const skippedPrefix of skippedPrefixes) {
            if (!completed.has(skippedPrefix) && !queued.has(skippedPrefix)) {
              completed.add(skippedPrefix);
            }
          }

          const children = [];
          for (const childPrefix of childPrefixes) {
            if (completed.has(childPrefix) || queued.has(childPrefix)) {
              continue;
            }
            children.push(childPrefix);
            queued.add(childPrefix);
          }
          queue.push(...children);

          if (forwardPlan.lastNext) {
            log(
              `"${prefix}" full page ends at "${forwardPlan.lastWord}" ` +
                `(next='${forwardPlan.lastNext}'); skip ${skippedPrefixes.length} ` +
                `covered groups → ${children.length} children` +
                (reverseLog ||
                  ` from ${prefix}${forwardPlan.lastNext}..`)
            );
          } else {
            log(
              `"${prefix}" full page ends on exact word — ` +
                `expand ${children.length} children` +
                reverseLog
            );
          }
        } else {
          log(`"${prefix}" branch complete`);
        }

        await saveState({ queue, completed, words, newWords });
        lastProgressAt = Date.now();

        if (COOLDOWN_MS > 0) {
          log(`Waiting ${COOLDOWN_MS} ms`);
          await sleep(COOLDOWN_MS);
        }
      } catch (error) {
        const failureCount = (failures.get(prefix) ?? 0) + 1;
        failures.set(prefix, failureCount);

        console.error(
          TAG,
          `Failed "${prefix}" attempt ${failureCount}:`,
          error.message
        );

        // Always requeue — never permanently drop a prefix while unattended.
        // Any prefix failing repeatedly blocks the worker; push it to the back so
        // other work continues. This prevents a single bad IP/token from freezing
        // the worker on the same prefix forever.
        if (failureCount >= 3) {
          queue.push(prefix);
          log(
            `Deferring stuck "${prefix}" to end of queue after ${failureCount} failures (${error.message.slice(0, 60)})`
          );
        } else {
          queue.unshift(prefix);
        }
        queued.add(prefix);
        await saveState({ queue, completed, words }).catch(() => {});
        if (shuttingDown) {
          break;
        }

        const retryAfterMs = parseRetryAfterMs(error);
        if (retryAfterMs) {
          log(`Rate limited — waiting ${retryAfterMs} ms before retry`);
          await sleep(retryAfterMs);
          failures.set(prefix, Math.max(0, failureCount - 1));
          continue;
        }

        // Soft recover Turnstile misses: one quick reload, then rotate. The
        // token pool already retries internally; a hard failure usually means
        // the IP/circuit is bad, so don't burn 30–60s on repeated soft reloads.
        const msg = String(error?.message ?? error ?? "");
        if (/No Turnstile token/i.test(msg) && failureCount <= 2) {
          try {
            log("Turnstile miss — soft reload before rotate");
            page._lllNextToken = null;
            page._lllNextTokenPromise = null;
            page._lllTokenConsumed = false;
            page._lllTsReady = false;
            page._lllTsUses = 0;
            await page.goto(TARGET_URL, {
              waitUntil: "domcontentloaded",
              timeout: 90_000
            });
            await sleep(500);
            await ensureCustomSearch(page);
            await ensureProMode(page);
            const token = await mintFreshTurnstileToken(page, {
              timeoutMs: 5_000,
              allowSiteFallback: true,
              forceRemount: true,
              nudge: true
            });
            if (token) {
              page._lllNextToken = token;
              page._lllTokenConsumed = false;
              failures.set(prefix, Math.max(0, failureCount - 1));
              continue;
            }
            log("Soft reload mint failed — rotating immediately");
            // Do not retry on the same bad IP; fall through to rotateIp.
          } catch (reloadError) {
            log(
              `Soft reload failed: ${String(reloadError.message).slice(0, 120)}`
            );
            if (failureCount < 2) {
              await sleep(2_000);
              continue;
            }
          }
        }

        if (/API (?:401|403)\b/i.test(msg) && ANTIBOT_BACKOFF_MS > 0) {
          const workerJitterMs =
            (Number.parseInt(WORKER_ID, 10) || 0) % 7 * 3_000;
          const waitMs = ANTIBOT_BACKOFF_MS + workerJitterMs;
          log(
            `Anti-bot rejection — cooling down ${Math.round(waitMs / 1000)}s before rotating`
          );
          await sleep(waitMs);
          if (shuttingDown) {
            break;
          }
        }

        if (mode !== "off" && isRotateWorthyError(error)) {
          try {
            await rotateIp(error.message.slice(0, 80));
            failures.set(prefix, Math.max(0, failureCount - 1));
          } catch (rotateError) {
            log(
              `rotate after error failed: ${rotateError.message.slice(0, 120)}`
            );
            await sleep(15_000);
          }
          continue;
        }

        // Soft failures: backoff, then rotate every few hits.
        await sleep(Math.min(60_000, 2 ** Math.min(failureCount, 6) * 1000));
        if (mode !== "off" && failureCount % 2 === 0) {
          try {
            await rotateIp(error.message.slice(0, 80));
          } catch {
            // keep going; supervisor will respawn if wedged
          }
        }
      }
    }

    await saveState({ queue, completed, words });
    log(
      `Worker done. prefixes=${completed.size} words=${words.size}`
    );
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    if (launchedByScript && context) {
      await context.close().catch(() => {});
    }
    await workerTor.stop().catch(() => {});
    releaseWorkerLockSync();
  }
}

process.once("exit", releaseWorkerLockSync);

process.on("uncaughtException", error => {
  if (isClosedTargetError(error)) {
    console.error(TAG, "uncaughtException (ignored closed target)", error?.message ?? error);
    return;
  }
  console.error(TAG, "uncaughtException", error);
  process.exit(1);
});

process.on("unhandledRejection", error => {
  // Closing Chrome mid-Turnstile mint leaves orphaned mouse.move promises.
  // Those must not kill the worker — rotate/retry already handles recovery.
  if (isClosedTargetError(error)) {
    console.error(
      TAG,
      "unhandledRejection (ignored closed target)",
      String(error?.message ?? error).slice(0, 120)
    );
    return;
  }
  console.error(TAG, "unhandledRejection", error);
  process.exit(1);
});

const isAuditMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url);

export {
  ALPHABET,
  LIMIT,
  API_PATH,
  REVERSE_SORT,
  assertAuthorizedTarget,
  extractWord,
  findRecordArray,
  launchSession,
  loadProxyList,
  mergeForwardAndReversePlans,
  mergeSharedOutput,
  mintFreshTurnstileToken,
  performSearchDirect,
  planChildrenFromFullPage,
  planChildrenFromFullPageReverse,
  preparePage,
  ProxyRotator,
  sleep,
  takeTokenFromPool,
  torReachable,
  WorkerTor
};

if (isAuditMain) {
  main().catch(error => {
    console.error(TAG, error);
    process.exit(1);
  });
}
