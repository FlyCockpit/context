import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import { PermanentDatabaseError, queryOnce, waitForPostgres } from "./postgres-ready.ts";

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** Starts `server` on a free loopback port; returns the port and a closer. */
async function listen(server: Server): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

function message(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), length, body]);
}
const AUTH_OK = message("R", Buffer.from([0, 0, 0, 0]));
const READY = message("Z", Buffer.from("I"));
function errorResponse(code: string, text: string): Buffer {
  return message("E", Buffer.from(`SFATAL\0VFATAL\0C${code}\0M${text}\0\0`));
}

test("waitForPostgres retries until a query succeeds", async () => {
  let calls = 0;
  const attempts = await waitForPostgres("postgres://x", {
    timeoutMs: 10_000,
    ...fakeClock(),
    probe: async () => {
      if (++calls < 4) throw new Error("Connection terminated unexpectedly");
    },
  });
  assert.equal(attempts, 4);
});

test("waitForPostgres gives up after the timeout with the last error", async () => {
  const limits: number[] = [];
  await assert.rejects(
    waitForPostgres("postgres://x", {
      timeoutMs: 5_000,
      attemptTimeoutMs: 3_000,
      ...fakeClock(),
      probe: async (_url, timeoutMs) => {
        limits.push(timeoutMs);
        throw new Error("the database system is starting up");
      },
    }),
    /did not answer a query within 5s \(the database system is starting up\)/,
  );
  // Each attempt is capped by the time left, and the waits never overshoot.
  assert.deepEqual(limits, [3000, 3000, 3000, 2000, 1000, 1]);
});

test("waitForPostgres stops at once on an error waiting cannot fix", async () => {
  let calls = 0;
  await assert.rejects(
    waitForPostgres("postgres://x", {
      timeoutMs: 60_000,
      ...fakeClock(),
      probe: async () => {
        calls++;
        throw new PermanentDatabaseError("password authentication failed (SQLSTATE 28P01)");
      },
    }),
    PermanentDatabaseError,
  );
  assert.equal(calls, 1);
});

// What Docker's port proxy does while the container is still in initdb: the
// TCP connection is accepted and then closed. A port probe would call this ready.
test("queryOnce rejects when the port accepts but closes the connection", async () => {
  const server = await listen(createServer((socket) => socket.destroy()));
  try {
    await assert.rejects(queryOnce(`postgres://u:p@127.0.0.1:${server.port}/db`, 1000));
  } finally {
    server.close();
  }
});

test("queryOnce rejects when the port accepts but never answers", async () => {
  const server = await listen(createServer(() => {}));
  try {
    await assert.rejects(queryOnce(`postgres://u:p@127.0.0.1:${server.port}/db`, 300));
  } finally {
    server.close();
  }
});

test("queryOnce gives up on a server that completes the handshake and then stalls", {
  timeout: 10_000,
}, async () => {
  let queried = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  const server = await listen(
    createServer((socket) => {
      socket.once("data", () => {
        socket.write(Buffer.concat([AUTH_OK, READY]));
        socket.once("data", () => {
          queried = true; // the SELECT 1 arrived; never answer it
        });
      });
      socket.on("close", resolveClosed);
    }),
  );
  try {
    const started = Date.now();
    await assert.rejects(queryOnce(`postgres://u:p@127.0.0.1:${server.port}/db`, 300));
    assert.ok(Date.now() - started < 2000, "the attempt is bounded by its timeout");
    assert.ok(queried, "the handshake completed and the query was sent");
    // The stalled connection is closed; a rejecting timer keeps a regression
    // from hanging here, so the finally below still closes the server.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("the stalled connection was not closed")), 5000);
      }),
    ]).finally(() => clearTimeout(timer));
  } finally {
    server.close();
  }
});

test("queryOnce succeeds against a server that answers SELECT 1", async () => {
  const server = await listen(
    createServer((socket) => {
      socket.once("data", () => {
        socket.write(Buffer.concat([AUTH_OK, READY]));
        socket.once("data", () =>
          socket.write(Buffer.concat([message("C", Buffer.from("SELECT 1\0")), READY])),
        );
      });
    }),
  );
  try {
    await queryOnce(`postgres://u:p@127.0.0.1:${server.port}/db`, 1000);
  } finally {
    server.close();
  }
});

test("queryOnce reports wrong credentials and missing databases as permanent", async () => {
  for (const code of ["28P01", "3D000"]) {
    const server = await listen(
      createServer((socket) => socket.once("data", () => socket.end(errorResponse(code, "nope")))),
    );
    try {
      await assert.rejects(
        queryOnce(`postgres://u:p@127.0.0.1:${server.port}/db`, 1000),
        (err: unknown) => err instanceof PermanentDatabaseError && err.message.includes(code),
      );
    } finally {
      server.close();
    }
  }
  await assert.rejects(queryOnce("not a url"), PermanentDatabaseError);
  await assert.rejects(queryOnce("mysql://u@localhost/db"), PermanentDatabaseError);
});

test("queryOnce treats a server that is starting up as retryable", async () => {
  const server = await listen(
    createServer((socket) =>
      socket.once("data", () =>
        socket.end(errorResponse("57P03", "the database system is starting up")),
      ),
    ),
  );
  try {
    await assert.rejects(
      queryOnce(`postgres://u:p@127.0.0.1:${server.port}/db`, 1000),
      (err: unknown) => !(err instanceof PermanentDatabaseError),
    );
  } finally {
    server.close();
  }
});
