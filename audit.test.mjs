import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lll-audit-test-"));
process.env.EXIT_IP_REGISTRY = path.join(tempDir, "exit-ips.json");
process.env.TARGET_URL = "http://localhost:3000";

const {
  ProxyRotator,
  WorkerTor,
  assertAuthorizedTarget,
  mintFreshTurnstileToken,
  takeTokenFromPool
} = await import(`./audit.mjs?test=${Date.now()}`);

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("authorized target guard rejects unrelated production hosts", () => {
  assert.doesNotThrow(() =>
    assertAuthorizedTarget("http://localhost:3000")
  );
  assert.throws(
    () => assertAuthorizedTarget("https://example.com"),
    /Refusing to run/
  );
});

test("Tor rotator always delegates to the dedicated worker daemon", async () => {
  let rotations = 0;
  const rotator = new ProxyRotator({
    mode: "tor",
    list: ["http://should-not-be-used.invalid:8080"],
    workerTor: {
      async startFresh() {
        rotations += 1;
        return "socks5://127.0.0.1:19999";
      }
    }
  });

  const first = await rotator.next();
  const second = await rotator.next();
  assert.equal(rotations, 2);
  assert.equal(first.server, "socks5://127.0.0.1:19999");
  assert.match(second.label, /^tor#2 /);
});

test("Tor control client authenticates before requesting NEWNYM", async () => {
  const cookie = Buffer.from("0123456789abcdef", "utf8");
  const cookieFile = path.join(tempDir, "control-cookie");
  await fs.writeFile(cookieFile, cookie);

  let request = "";
  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      request += chunk;
      if (request.includes("QUIT\r\n")) {
        socket.end("250 OK\r\n250 OK\r\n250 closing connection\r\n");
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const tor = new WorkerTor("0");
    tor.controlPort = address.port;
    tor.cookieFile = cookieFile;
    await tor.sendControl("SIGNAL NEWNYM");

    assert.match(
      request,
      new RegExp(`^AUTHENTICATE ${cookie.toString("hex")}\\r\\n`)
    );
    assert.match(request, /SIGNAL NEWNYM\r\nQUIT\r\n$/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("persistent Tor rotates circuits without restarting its daemon", async () => {
  const tor = new WorkerTor("99");
  let starts = 0;
  let newnyms = 0;
  const exits = ["10.0.0.1", "10.0.0.2"];
  tor.startDaemon = async () => {
    starts += 1;
  };
  tor.newIdentity = async () => {
    newnyms += 1;
  };
  tor.probeExitIp = async () => exits.shift() ?? "10.0.0.2";

  await tor.startFresh();
  await tor.startFresh();

  assert.equal(starts, 2);
  assert.equal(newnyms, 1);
  assert.equal(tor.exitIp, "10.0.0.2");
});

test("Turnstile minting is single-flight per page", async () => {
  let evaluates = 0;
  const page = {
    async evaluate() {
      evaluates += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return false;
    }
  };

  const [first, second] = await Promise.all([
    mintFreshTurnstileToken(page),
    mintFreshTurnstileToken(page)
  ]);
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(evaluates, 1);
});

test("token pool makes one bounded mint attempt instead of retry-storming", async () => {
  let evaluates = 0;
  const page = {
    async evaluate() {
      evaluates += 1;
      return false;
    }
  };

  const token = await takeTokenFromPool(page, 100);
  assert.equal(token, null);
  assert.equal(evaluates, 1);
});
