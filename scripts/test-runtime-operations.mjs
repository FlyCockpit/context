/** Explicit operations smoke; owns disposable services and never loads the root .env. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { containerPrefix } from "./backup/e2e-names.mjs";

// Exact tag, the Alpine variant of compose.yaml's postgres:18.6, so the
// disposable fixture never floats to a newer minor (docs/hosting.md).
const POSTGRES_IMAGE = "postgres:18.6-alpine";
const root = fileURLToPath(new URL("..", import.meta.url));
const file = fileURLToPath(import.meta.url);

async function runtimeCheck() {
  const [jobs, { default: prisma }, { z }] = await Promise.all([
    import("../packages/jobs/src/index.ts"),
    import("../packages/db/src/index.ts"),
    import("zod"),
  ]);
  const runId = randomUUID().slice(0, 8);
  const seen = [];
  let failures = 0;
  const echo = jobs.defineJob(`ops.echo-${runId}`, z.object({ message: z.string() }));
  const flaky = jobs.defineJob(`ops.flaky-${runId}`, z.object({}), {
    maxAttempts: 2,
    backoff: { baseMs: 10, maxMs: 10 },
  });
  const slow = jobs.defineJob(`ops.slow-${runId}`, z.object({ n: z.number() }));
  const runners = [];
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 15_000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
      await delay(25);
    }
  };
  const statusOf = async (id) =>
    (await prisma.backgroundJob.findUnique({ where: { id }, select: { status: true } }))?.status;
  try {
    // 1. Real claim SQL, retries with backoff, and success bookkeeping.
    const runner = jobs.createJobRunner({
      jobs: [
        jobs.handleJob(echo, async ({ payload }) => {
          seen.push(payload.message);
        }),
        jobs.handleJob(flaky, async ({ attempt }) => {
          if (attempt === 1) {
            failures++;
            throw new Error("first attempt fails");
          }
        }),
      ],
      pollIntervalMs: 50,
    });
    runners.push(runner);
    await runner.start();
    const ok = await jobs.enqueueJob(echo, { message: "hello" });
    const retried = await jobs.enqueueJob(flaky, {});
    await waitFor(async () => (await statusOf(ok.id)) === "succeeded", "echo success");
    await waitFor(async () => (await statusOf(retried.id)) === "succeeded", "retry success");
    assert.deepEqual(seen, ["hello"]);
    assert.equal(failures, 1);
    const retriedRow = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: retried.id } });
    assert.equal(retriedRow.attempts, 2);
    assert.equal(retriedRow.lockedBy, null);

    // 2. Dedupe keys insert exactly one row under a race.
    const racing = await Promise.all(
      Array.from({ length: 5 }, () =>
        jobs.enqueueJob(echo, { message: "once" }, { dedupeKey: `ops-${runId}` }),
      ),
    );
    assert.equal(new Set(racing.map((r) => r.id)).size, 1);
    assert.equal(racing.filter((r) => r.created).length, 1);
    await waitFor(async () => seen.includes("once"), "deduped job");
    await runner.stop();

    // 3. SKIP LOCKED: two runners never execute one row twice.
    const executions = new Map();
    const handler = jobs.handleJob(slow, async ({ id }) => {
      executions.set(id, (executions.get(id) ?? 0) + 1);
      await delay(20);
    });
    const a = jobs.createJobRunner({ jobs: [handler], concurrency: 4, pollIntervalMs: 20 });
    const b = jobs.createJobRunner({ jobs: [handler], concurrency: 4, pollIntervalMs: 20 });
    runners.push(a, b);
    const ids = [];
    for (let n = 0; n < 40; n++) ids.push((await jobs.enqueueJob(slow, { n })).id);
    await Promise.all([a.start(), b.start()]);
    await waitFor(
      async () =>
        (await prisma.backgroundJob.count({ where: { id: { in: ids }, status: "succeeded" } })) ===
        ids.length,
      "parallel runners",
    );
    assert.equal(executions.size, ids.length);
    assert.ok([...executions.values()].every((count) => count === 1));
    await Promise.all([a.stop(), b.stop()]);

    // 4. Boot recovery returns an orphaned running row to the queue.
    const orphan = await prisma.backgroundJob.create({
      data: {
        type: echo.type,
        payload: { message: "orphan" },
        status: "running",
        attempts: 1,
        lockedAt: new Date(Date.now() - 60_000),
        lockedBy: "dead-process",
      },
      select: { id: true },
    });
    const recovering = jobs.createJobRunner({
      jobs: [
        jobs.handleJob(echo, async ({ payload }) => {
          seen.push(payload.message);
        }),
      ],
      pollIntervalMs: 50,
      staleLockMs: 30_000,
    });
    runners.push(recovering);
    await recovering.start();
    await waitFor(async () => (await statusOf(orphan.id)) === "succeeded", "orphan recovery");
    assert.ok(seen.includes("orphan"));
    console.log("jobs: claim, retry, dedupe, SKIP LOCKED, and boot recovery passed.");
  } finally {
    await Promise.all(runners.map((runner) => runner.stop()));
    await prisma.$disconnect();
  }
}

/**
 * The actual password sign-in handler, paused at both sides of its last
 * pre-insert fence check, against the actual PostgreSQL adapter. The password
 * writer must finish (including its post-commit sweep) before we release the
 * sign-in; a timer never establishes the interleaving.
 */
async function passwordSignInRaceCheck() {
  assert.equal(process.env.DATABASE_POOL_MAX, "3");
  const [{ auth }, { handlePasswordAuthRequest }, links, { default: prisma }] = await Promise.all([
    import("../packages/auth/src/index.ts"),
    import("../packages/auth/src/password-auth-handler.ts"),
    import("../packages/auth/src/password-reset-links.ts"),
    import("../packages/db/src/index.ts"),
  ]);
  const context = await auth.$context;
  const oldPassword = "disposable-old-proof-password-13579";
  const newPassword = "disposable-new-proof-password-24680";
  const oldHash = await context.password.hash(oldPassword);
  const created = [];
  const hooks = context.options.databaseHooks.session.create;
  const originalBefore = hooks.before;
  const originalVerify = context.password.verify;
  const request = (path, body, cookie = "") =>
    new Request(`${process.env.BETTER_AUTH_URL}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: process.env.BETTER_AUTH_URL,
        cookie,
      },
      body: JSON.stringify(body),
    });
  const send = (path, body, cookie) => handlePasswordAuthRequest(auth, request(path, body, cookie));
  const fixtureUser = async (label) => {
    const id = `password-race-${label}-${randomUUID()}`;
    created.push(id);
    const email = `${id}@example.test`;
    await prisma.user.create({
      data: { id, name: "Password race", email, emailVerified: true },
    });
    await prisma.account.create({
      data: {
        id: randomUUID(),
        accountId: id,
        userId: id,
        providerId: "credential",
        password: oldHash,
      },
    });
    return { id, email };
  };
  const signedIn = async (user) => {
    const response = await send("/sign-in/email", { email: user.email, password: oldPassword });
    assert.equal(response.status, 200, "fixture's normal sign-in succeeds");
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie.includes("session_token="));
    return cookie;
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  try {
    for (const writer of ["change-keep", "change-revoke", "reset"]) {
      for (const point of ["verified", "before-insert"]) {
        const user = await fixtureUser(`${writer}-${point}`);
        const writerCookie = await signedIn(user);
        await prisma.session.createMany({
          data: [
            {
              id: randomUUID(),
              userId: user.id,
              token: randomUUID(),
              expiresAt: new Date(Date.now() + 60_000),
            },
            {
              id: randomUUID(),
              userId: user.id,
              token: randomUUID(),
              expiresAt: new Date(Date.now() + 60_000),
            },
          ],
        });
        await prisma.mcpAgentToken.create({
          data: {
            userId: user.id,
            name: "race",
            lookupPrefix: randomUUID(),
            secretDigest: randomUUID(),
          },
        });
        const clientId = randomUUID();
        await prisma.oauthClient.create({
          data: {
            clientId,
            userId: user.id,
            scopes: [],
            contacts: [],
            redirectUris: [],
            postLogoutRedirectUris: [],
            grantTypes: [],
            responseTypes: [],
          },
        });
        await prisma.mcpGrant.create({ data: { userId: user.id, clientId, referenceId: "race" } });
        await prisma.oauthRefreshToken.create({
          data: {
            token: randomUUID(),
            clientId,
            userId: user.id,
            expiresAt: new Date(Date.now() + 60_000),
            resources: [],
            requestedUserInfoClaims: [],
            scopes: [],
          },
        });
        await prisma.oauthAccessToken.create({
          data: {
            token: randomUUID(),
            clientId,
            userId: user.id,
            expiresAt: new Date(Date.now() + 60_000),
            resources: [],
            requestedUserInfoClaims: [],
            scopes: [],
          },
        });
        await prisma.oauthConsent.create({
          data: {
            clientId,
            userId: user.id,
            resources: [],
            requestedUserInfoClaims: [],
            scopes: [],
          },
        });
        const challenge = `2fa-${randomUUID()}`;
        await prisma.verification.create({
          data: { identifier: challenge, value: user.id, expiresAt: new Date(Date.now() + 60_000) },
        });
        const reached = deferred();
        const released = deferred();
        let armed = true;
        if (point === "verified") {
          context.password.verify = async (input) => {
            const valid = await originalVerify(input);
            if (armed && valid && input.hash === oldHash && input.password === oldPassword) {
              armed = false;
              reached.resolve();
              await released.promise;
            }
            return valid;
          };
        } else {
          hooks.before = async (session, endpoint) => {
            const result = await originalBefore(session, endpoint);
            if (armed && session.userId === user.id && endpoint?.path === "/sign-in/email") {
              armed = false;
              reached.resolve();
              await released.promise;
            }
            return result;
          };
        }
        const signingIn = send("/sign-in/email", { email: user.email, password: oldPassword });
        try {
          // A failure before the pause must fail promptly instead of hanging.
          await Promise.race([
            reached.promise,
            signingIn.then(() => {
              throw new Error("Sign-in finished before its pause point");
            }),
          ]);
          let changed;
          if (writer.startsWith("change-")) {
            changed = await send(
              "/change-password",
              {
                currentPassword: oldPassword,
                newPassword,
                revokeOtherSessions: writer === "change-revoke",
              },
              writerCookie,
            );
          } else if (writer === "reset") {
            const token = randomUUID();
            await prisma.verification.create({
              data: {
                identifier: `reset-password:${token}`,
                value: user.id,
                expiresAt: new Date(Date.now() + 60_000),
              },
            });
            assert.equal(
              await links.recordResetLinkMailed({ token, userId: user.id, email: user.email }),
              true,
            );
            changed = await send("/reset-password", { token, newPassword });
          }
          assert.equal(changed.status, 200, `${writer} completes while old proof is paused`);
          const credential = await prisma.account.findFirstOrThrow({
            where: { userId: user.id, providerId: "credential" },
          });
          assert.notEqual(credential.password, oldHash, "the password write is committed");
          assert.equal(
            await originalVerify({ hash: credential.password, password: newPassword }),
            true,
          );
          const isReset = writer === "reset";
          const revoked = isReset || writer === "change-revoke";
          const expectedSessions = isReset ? 0 : writer === "change-revoke" ? 1 : 3;
          assert.equal(
            await prisma.session.count({ where: { userId: user.id } }),
            expectedSessions,
            `${writer}: established sessions follow policy`,
          );
          const token = await prisma.mcpAgentToken.findFirstOrThrow({ where: { userId: user.id } });
          const grant = await prisma.mcpGrant.findFirstOrThrow({ where: { userId: user.id } });
          assert.equal(token.revokedAt !== null, revoked, `${writer}: MCP token follows policy`);
          assert.equal(grant.revokedAt !== null, revoked, `${writer}: MCP grant follows policy`);
          for (const delegate of [
            prisma.oauthAccessToken,
            prisma.oauthRefreshToken,
            prisma.oauthConsent,
          ]) {
            assert.equal(
              await delegate.count({ where: { userId: user.id } }),
              revoked ? 0 : 1,
              `${writer}: OAuth credentials follow policy`,
            );
          }
          if (isReset) {
            assert.equal(
              await prisma.verification.count({ where: { identifier: challenge } }),
              0,
              `${writer}: pending second-factor proof is revoked`,
            );
          }
          released.resolve();
          const raced = await signingIn;
          assert.equal(raced.status, 401, `${writer}/${point}: old proof is refused`);
          assert.equal((await raced.json()).code, "INVALID_EMAIL_OR_PASSWORD");
          assert.deepEqual(
            raced.headers.getSetCookie(),
            [],
            "a refused sign-in returns no cookies",
          );
          assert.equal(
            await prisma.session.count({ where: { userId: user.id } }),
            expectedSessions,
            "the delayed insert leaves no extra session",
          );
          console.log(
            `password sign-in: ${writer}/${point} refused the old proof on real PostgreSQL.`,
          );
        } finally {
          released.resolve();
          await signingIn.catch(() => {});
          context.password.verify = originalVerify;
          hooks.before = originalBefore;
        }
      }
    }
  } finally {
    context.password.verify = originalVerify;
    hooks.before = originalBefore;
    await prisma.verification.deleteMany({ where: { value: { in: created } } });
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  }
}

/**
 * Actual pinned Better Auth, production password mount/hooks/selective adapter,
 * and migrated PostgreSQL at the minimum pool size. SMTP is configured but no
 * mail/provider endpoint is invoked: token delivery proof is a fixture fact.
 */
async function inviteRaceCheck() {
  assert.equal(process.env.DATABASE_POOL_MAX, "3");
  const [
    { auth },
    { handlePasswordAuthRequest },
    links,
    { createSetPasswordToken },
    { withPasswordSignInFence },
    { default: prisma },
    { loadPg },
  ] = await Promise.all([
    import("../packages/auth/src/index.ts"),
    import("../packages/auth/src/password-auth-handler.ts"),
    import("../packages/auth/src/password-reset-links.ts"),
    import("../packages/auth/src/invite-verification.ts"),
    import("../packages/auth/src/password-sign-in-fence.ts"),
    import("../packages/db/src/index.ts"),
    import("./db/lib/prisma.mjs"),
  ]);
  // Resolve the pinned API from its owning workspace, not root hoisting.
  const authApi = createRequire(new URL("../packages/auth/package.json", import.meta.url)).resolve(
    "better-auth/api",
  );
  const { createEmailVerificationToken } = await import(authApi);
  const context = await auth.$context;
  assert.equal(context.options.emailAndPassword.requireEmailVerification, true);
  const pg = loadPg();
  const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const created = [];
  const minted = [];
  const origin = process.env.BETTER_AUTH_URL;
  const originalPassword = "fixture-original-password-12345";
  const invitee = async (label, { credential = true } = {}) => {
    const id = `invite-${label}-${randomUUID()}`;
    const email = `${id}@example.test`;
    created.push(id);
    await prisma.user.create({ data: { id, name: "Invitee", email, emailVerified: false } });
    if (credential) {
      await prisma.account.create({
        data: {
          userId: id,
          accountId: id,
          providerId: "credential",
          password: await context.password.hash(originalPassword),
        },
      });
    }
    return { id, email };
  };
  const mint = async (user, { mailed }) => {
    // users.mintSetPasswordLink is private. Use its existing token primitive
    // with its real setup lock and transaction-bound writer; no API authority.
    const token = await links.withCredentialSetupLock(user.id, (tx) =>
      createSetPasswordToken(
        {
          createVerificationValue: (data) => tx.verification.create({ data, select: { id: true } }),
        },
        user.id,
        new Date(Date.now() + 60 * 60 * 1000),
      ),
    );
    minted.push(token);
    if (mailed) {
      assert.equal(
        await links.recordResetLinkMailed({ token, userId: user.id, email: user.email }),
        true,
      );
    }
    return token;
  };
  const handleAuth = (request) => handlePasswordAuthRequest(auth, request);
  const spend = (token, newPassword = "fixture-reset-password-12345") =>
    handleAuth(
      new Request(`${origin}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ token, newPassword }),
      }),
    );
  const verified = async (user) =>
    (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified;
  const credentialOf = (user) =>
    prisma.account.findFirst({ where: { userId: user.id, providerId: "credential" } });
  const passwordWorks = async (user, password) => {
    const credential = await credentialOf(user);
    return (
      !!credential?.password && context.password.verify({ hash: credential.password, password })
    );
  };
  const resetLinks = (user) =>
    prisma.verification.count({
      where: { value: user.id, identifier: { startsWith: links.RESET_PASSWORD_IDENTIFIER_PREFIX } },
    });
  const proofIdentifier = (token) =>
    `reset-password-mailed:${createHash("sha256").update(token).digest("base64url")}`;
  const deadLinks = async (user, tokens) => {
    assert.equal(await resetLinks(user), 0, "no surviving sibling reset links");
    for (const token of tokens) assert.equal((await spend(token)).status, 400);
  };
  const verificationRequest = async (user) => {
    const token = await createEmailVerificationToken(context.secret, user.email);
    return () =>
      handleAuth(new Request(`${origin}/api/auth/verify-email?token=${encodeURIComponent(token)}`));
  };
  const linkIdp = (user) =>
    context.internalAdapter.createAccount({
      userId: user.id,
      providerId: "sso",
      accountId: randomUUID(),
    });

  // A separate holder and observer do not borrow slots from the app's pool.
  // Match this exact held advisory key (including objsubid), so the numeric
  // two-key credential lock cannot accidentally satisfy the setup barrier.
  const waitAtSetup = async (holderPid) => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const { rows } = await observer.query(
        `SELECT waiting.pid FROM pg_locks waiting JOIN pg_locks held
           ON waiting.database = held.database AND waiting.classid = held.classid
          AND waiting.objid = held.objid AND waiting.objsubid = held.objsubid
         WHERE held.pid = $1 AND held.locktype = 'advisory' AND held.granted
           AND waiting.locktype = 'advisory' AND NOT waiting.granted`,
        [holderPid],
      );
      if (rows.length > 0) return;
      await delay(10);
    }
    throw new Error("First writer did not reach the real credential-setup lock.");
  };
  const withSetupHolder = async (user, run) => {
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `set-password-link:${user.id}`,
      ]);
      const { rows } = await holder.query("SELECT pg_backend_pid() AS pid");
      return await run(holder, rows[0].pid);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  };
  const orderedAtSetup = (user, first, second) =>
    withSetupHolder(user, async (holder, pid) => {
      const pending = [];
      // Reflect immediately: a failed barrier must release the holder and drain
      // all started work, without unhandled rejections or another case's waiter.
      const start = (run) => {
        const result = Promise.resolve()
          .then(run)
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        pending.push(result);
        return result;
      };
      try {
        const winning = start(first);
        await waitAtSetup(pid);
        const losing = start(second);
        // At pool 3 the second writer can wait in the slot reservation FIFO.
        // Requiring a second PostgreSQL waiter here would deadlock the fixture.
        await holder.query("COMMIT");
        const results = await Promise.all([winning, losing]);
        return results.map((result) => {
          if ("error" in result) throw result.error;
          return result.value;
        });
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        await Promise.all(pending);
      }
    });

  await observer.connect();
  try {
    // Mailed-only mailbox proof, and every sibling is dead after either spend.
    for (const mailed of [false, true]) {
      const user = await invitee(mailed ? "mailed" : "shown");
      const sibling = await mint(user, { mailed: false });
      const token = await mint(user, { mailed });
      assert.equal((await spend(token)).status, 200);
      assert.equal(await verified(user), mailed, "only a mailed token proves the mailbox");
      assert.equal(await passwordWorks(user, "fixture-reset-password-12345"), true);
      await deadLinks(user, [token, sibling]);
      if (!mailed) {
        // Setting a password with a shown link leaves the invite pending.
        const delivered = await mint(user, { mailed: true });
        assert.equal((await spend(delivered)).status, 200);
        assert.equal(await verified(user), true);
        await deadLinks(user, [delivered]);
      } else {
        // A mailed forgot-password token still works after activation.
        const forgot = await mint(user, { mailed: true });
        assert.equal((await spend(forgot, "fixture-active-reset-password-12345")).status, 200);
        assert.equal(await passwordWorks(user, "fixture-active-reset-password-12345"), true);
        assert.equal(await verified(user), true);
        await deadLinks(user, [forgot]);
      }
    }

    for (const first of ["shown", "mailed"]) {
      const user = await invitee(`spends-${first}`);
      const shown = await mint(user, { mailed: false });
      const mailed = await mint(user, { mailed: true });
      const winningPassword = `${first}-winning-password-12345`;
      const losingPassword = "fixture-losing-password-12345";
      const [winner, loser] = await orderedAtSetup(
        user,
        () => spend(first === "shown" ? shown : mailed, winningPassword),
        () => spend(first === "shown" ? mailed : shown, losingPassword),
      );
      assert.equal(winner.status, 200);
      assert.equal(loser.status, 400);
      assert.equal(await verified(user), first === "mailed");
      assert.equal(await passwordWorks(user, winningPassword), true);
      assert.equal(await passwordWorks(user, losingPassword), false);
      await deadLinks(user, [shown, mailed]);
    }

    // Both orders use the real verify-email handler and activation adapter write.
    for (const first of ["shown", "verify"]) {
      const user = await invitee(`verification-${first}`);
      const token = await mint(user, { mailed: false });
      const sibling = await mint(user, { mailed: false });
      const verify = await verificationRequest(user);
      const shownPassword = "fixture-shown-before-verification-12345";
      const refusedPassword = "fixture-refused-after-verification-12345";
      const [winner, loser] = await orderedAtSetup(
        user,
        first === "shown" ? () => spend(token, shownPassword) : verify,
        first === "shown" ? verify : () => spend(token, refusedPassword),
      );
      assert.equal(winner.status, 200);
      assert.equal(loser.status, first === "shown" ? 200 : 400);
      assert.equal(await verified(user), true);
      assert.equal(await passwordWorks(user, shownPassword), first === "shown");
      assert.equal(await passwordWorks(user, refusedPassword), false);
      assert.equal(await passwordWorks(user, originalPassword), first === "verify");
      await deadLinks(user, [token, sibling]);
    }

    // Admission itself must re-read a committed activation after waiting. This
    // independent transaction intentionally bypasses HTTP preflight, not policy.
    const recheck = await invitee("consume-recheck");
    const recheckToken = await mint(recheck, { mailed: false });
    assert.equal(await links.isResetLinkRedeemable(recheckToken, { emailConfigured: true }), true);
    await withSetupHolder(recheck, async (holder, pid) => {
      await holder.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [recheck.id]);
      const decision = prisma
        .$transaction((tx) => links.admitResetSpend(tx, recheckToken, { emailConfigured: true }), {
          isolationLevel: "ReadCommitted",
          timeout: 15_000,
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      try {
        await waitAtSetup(pid);
        await holder.query("COMMIT");
        const result = await decision;
        if ("error" in result) throw result.error;
        assert.equal(result.value, false, "consume admission sees the newly activated state");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        await decision;
      }
    });
    assert.equal(await verified(recheck), true);
    assert.equal((await spend(recheckToken)).status, 400);
    await deadLinks(recheck, [recheckToken]);

    // The already-authorized internal account seam exercises pending IdP
    // cleanup without a provider callback or changing default linking trust.
    const pending = await invitee("pending-idp");
    const shownPassword = "fixture-admin-shown-password-12345";
    assert.equal((await spend(await mint(pending, { mailed: false }), shownPassword)).status, 200);
    const sibling = await mint(pending, { mailed: false });
    const agentToken = await prisma.mcpAgentToken.create({
      data: {
        userId: pending.id,
        name: "disposable activation fixture",
        lookupPrefix: randomUUID(),
        secretDigest: randomBytes(32).toString("hex"),
      },
    });
    const grant = await prisma.mcpGrant.create({
      data: { userId: pending.id, clientId: randomUUID(), referenceId: randomUUID() },
    });
    await linkIdp(pending);
    assert.equal((await credentialOf(pending)).password, null);
    assert.equal(await passwordWorks(pending, shownPassword), false);
    assert.equal(await verified(pending), false, "the internal link seam proves no mailbox");
    assert.ok(
      (await prisma.mcpAgentToken.findUniqueOrThrow({ where: { id: agentToken.id } })).revokedAt,
      "MCP token remains a revoked tombstone",
    );
    assert.ok(
      (await prisma.mcpGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt,
      "MCP grant remains a revoked tombstone",
    );
    await context.internalAdapter.updateUser(pending.id, { emailVerified: true });
    assert.equal(await verified(pending), true);
    await deadLinks(pending, [sibling]);

    for (const first of ["shown", "sso"]) {
      const user = await invitee(`idp-race-${first}`);
      const token = await mint(user, { mailed: false });
      const sibling = await mint(user, { mailed: false });
      const [winner, loser] = await orderedAtSetup(
        user,
        first === "shown" ? () => spend(token, shownPassword) : () => linkIdp(user),
        first === "shown" ? () => linkIdp(user) : () => spend(token, shownPassword),
      );
      assert.equal(first === "shown" ? winner.status : loser.status, first === "shown" ? 200 : 400);
      assert.equal((await credentialOf(user)).password, null);
      assert.equal(await passwordWorks(user, shownPassword), false);
      assert.equal(await verified(user), false);
      assert.equal(
        await prisma.account.count({ where: { userId: user.id, providerId: "sso" } }),
        1,
      );
      await deadLinks(user, [token, sibling]);
    }

    const normalSso = await invitee("active-idp");
    await context.internalAdapter.updateUser(normalSso.id, { emailVerified: true });
    const oldCredential = await credentialOf(normalSso);
    await linkIdp(normalSso);
    assert.ok(
      (await credentialOf(normalSso)).password === oldCredential.password,
      "active verified SSO preserves the existing password",
    );
    // A normal post-link session uses the actual password handler, with the
    // user's preserved password and verified mailbox. No SSO trust is added.
    const signedIn = await handleAuth(
      new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email: normalSso.email, password: originalPassword }),
      }),
    );
    assert.equal(signedIn.status, 200);
    assert.equal(await prisma.session.count({ where: { userId: normalSso.id } }), 1);
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: normalSso.id } })).role,
      "user",
    );
    assert.equal(await prisma.mcpAgentToken.count({ where: { userId: normalSso.id } }), 0);
    assert.equal(await prisma.mcpGrant.count({ where: { userId: normalSso.id } }), 0);

    const zero = await invitee("zero-accounts", { credential: false });
    assert.equal((await spend(await mint(zero, { mailed: false }), shownPassword)).status, 200);
    assert.equal(await verified(zero), false);
    assert.equal(await passwordWorks(zero, shownPassword), true);
    await linkIdp(zero);
    assert.equal((await credentialOf(zero)).password, null);
    const third = await invitee("third-noncredential");
    // Two credential rows precede a third identity: a take:2 account projection
    // must never accidentally classify this existing IdP user as pending.
    await prisma.account.create({
      data: {
        userId: third.id,
        accountId: randomUUID(),
        providerId: "credential",
        password: await context.password.hash(originalPassword),
      },
    });
    await prisma.account.create({
      data: { userId: third.id, accountId: randomUUID(), providerId: "existing-idp" },
    });
    const existingCredential = await credentialOf(third);
    const thirdToken = await mint(third, { mailed: false });
    assert.equal((await spend(thirdToken, shownPassword)).status, 400);
    await linkIdp(third);
    assert.ok(
      (await prisma.account.findUniqueOrThrow({ where: { id: existingCredential.id } }))
        .password === existingCredential.password,
      "an existing noncredential identity is not a pending invite",
    );
    await deadLinks(third, [thirdToken]);

    // The injected failure is the pinned internal writer seam. Real PostgreSQL
    // must roll back the consumed token, mailed proof, sibling and email flag.
    const rollback = await invitee("rollback");
    const rollbackSibling = await mint(rollback, { mailed: false });
    const rollbackToken = await mint(rollback, { mailed: true });
    const proofWhere = { identifier: proofIdentifier(rollbackToken) };
    const beforeProof = await prisma.verification.findFirstOrThrow({ where: proofWhere });
    const beforeCredential = await credentialOf(rollback);
    const updatePassword = context.internalAdapter.updatePassword;
    let failureCalls = 0;
    try {
      context.internalAdapter.updatePassword = async () => {
        failureCalls++;
        throw new Error("fixture credential-write failure");
      };
      assert.equal((await spend(rollbackToken)).status, 500);
      assert.equal(failureCalls, 1, "the real reset reached the failing credential writer");
    } finally {
      context.internalAdapter.updatePassword = updatePassword;
    }
    assert.equal(await verified(rollback), false);
    assert.equal(await resetLinks(rollback), 2);
    assert.deepEqual(
      await prisma.verification.findFirstOrThrow({ where: proofWhere }),
      beforeProof,
    );
    assert.ok(
      (await credentialOf(rollback)).password === beforeCredential.password,
      "a failed spend leaves the existing password unchanged",
    );
    assert.equal((await spend(rollbackToken)).status, 200);
    assert.equal(await verified(rollback), true);
    assert.equal(await prisma.verification.count({ where: proofWhere }), 0);
    await deadLinks(rollback, [rollbackToken, rollbackSibling]);

    // Actual BEFORE passes while the old credential is live. Promise latches
    // delay INSERT until IdP clearing and sweeps commit; actual AFTER registers
    // the late row and the production fingerprint fence must remove it.
    for (const kind of ["session", "challenge"]) {
      const user = await invitee(`late-${kind}`);
      let enter;
      let release;
      const entered = new Promise((resolve) => {
        enter = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      const delayed = withPasswordSignInFence(
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ email: user.email, password: originalPassword }),
        }),
        async () => {
          const hooks = context.options.databaseHooks;
          await hooks.session.create.before({ userId: user.id }, { path: "/sign-in/email" });
          enter();
          await released;
          if (kind === "session") {
            const session = await prisma.session.create({
              data: {
                userId: user.id,
                token: randomUUID(),
                expiresAt: new Date(Date.now() + 60_000),
              },
            });
            await hooks.session.create.after(session, { path: "/sign-in/email" });
          } else {
            const challenge = await prisma.verification.create({
              data: {
                identifier: `2fa-${randomUUID()}`,
                value: user.id,
                expiresAt: new Date(Date.now() + 60_000),
              },
            });
            await hooks.verification.create.after(challenge);
          }
          return new Response("fixture session/challenge");
        },
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await Promise.race([
          entered,
          delayed.then(() => {
            throw new Error("Old proof did not reach the actual BEFORE hook latch.");
          }),
        ]);
        await linkIdp(user);
        assert.equal((await credentialOf(user)).password, null);
      } finally {
        release();
        await delayed;
      }
      const result = await delayed;
      if ("error" in result) throw result.error;
      assert.equal(result.value.status, 401);
      assert.equal(result.value.headers.get("set-cookie"), null);
      assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
      assert.equal(
        await prisma.verification.count({
          where: { value: user.id, identifier: { startsWith: "2fa-" } },
        }),
        0,
      );
    }
    console.log(
      "invites: real Postgres (pool max 3) passed mailed-only proof, ordered spends/verification/IdP activation, consume recheck, rollback/retry, MCP tombstones, and late session/challenge fences.",
    );
  } finally {
    try {
      // Verification has no user FK; mailed proof values are JSON. Clean both
      // by bounded fixture identifiers, then use DB cascades for fixture users.
      await prisma.verification.deleteMany({
        where: {
          OR: [{ value: { in: created } }, { identifier: { in: minted.map(proofIdentifier) } }],
        },
      });
      await prisma.user.deleteMany({ where: { id: { in: created } } });
    } finally {
      await observer.end();
      await prisma.$disconnect();
    }
  }
}

async function main() {
  if (process.argv[2] === "--runtime-child") {
    assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
    await runtimeCheck();
    return;
  }
  if (process.argv[2] === "--auth-child") {
    assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
    if (process.argv[3] === "password-signin-race") await passwordSignInRaceCheck();
    else if (process.argv[3] === "invite-race") await inviteRaceCheck();
    else throw new Error("Unknown auth child");
    return;
  }
  if (process.argv[2] !== "--disposable-services") {
    throw new Error("Use node scripts/test-runtime-operations.mjs --disposable-services.");
  }
  // Container names only: `--container-prefix`, else TEST_CONTAINER_PREFIX
  // (shared with backup:test and db:test-migrations), else the default.
  const namePrefix = containerPrefix(process.argv.slice(3), process.env, "cockpit-context-runtime");
  const environment = { PATH: process.env.PATH };
  const docker = (...args) =>
    execFileSync("docker", args, {
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  for (const image of [POSTGRES_IMAGE]) {
    docker("image", "inspect", image, "--format", "{{.Id}}");
  }
  const temporary = mkdtempSync(resolve(tmpdir(), "cockpit-context-runtime-operations-"));
  const containers = [];
  try {
    const password = randomUUID();
    const postgres = docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      `${namePrefix}-pg-${randomUUID()}`,
      "--memory",
      "256m",
      "--tmpfs",
      "/var/lib/postgresql:rw,size=256m",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      POSTGRES_IMAGE,
    );
    containers.push(postgres);
    const port = (id, mapping) => {
      const value = docker("port", id, mapping).split(":").at(-1);
      assert.match(value, /^\d+$/);
      return value;
    };
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port(postgres, "5432/tcp")}/postgres`;
    for (let attempt = 0; ; attempt++) {
      try {
        docker("exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "postgres");
        break;
      } catch {
        if (attempt === 49) throw new Error("Disposable PostgreSQL did not become ready.");
        await delay(100);
      }
    }
    // Copy the real Prisma config and schema away from root .env. Only installed
    // packages are linked; dotenv resolves a missing file inside this fixture.
    const prismaCwd = resolve(temporary, "packages/db");
    mkdirSync(prismaCwd, { recursive: true });
    cpSync(resolve(root, "packages/db/prisma.config.ts"), resolve(prismaCwd, "prisma.config.ts"));
    for (const folder of ["schema", "migrations", "fixtures"]) {
      cpSync(resolve(root, "packages/db/prisma", folder), resolve(prismaCwd, "prisma", folder), {
        recursive: true,
      });
    }
    cpSync(resolve(root, "packages/db/package.json"), resolve(prismaCwd, "package.json"));
    for (const folder of ["db", "backup"]) {
      cpSync(resolve(root, "scripts", folder), resolve(temporary, "scripts", folder), {
        recursive: true,
      });
    }
    symlinkSync(resolve(root, "node_modules"), resolve(temporary, "node_modules"), "dir");
    symlinkSync(
      resolve(root, "packages/db/node_modules"),
      resolve(prismaCwd, "node_modules"),
      "dir",
    );
    const fixtureEnv = {
      ...environment,
      DATABASE_URL: databaseUrl,
      NODE_ENV: "production",
      BACKUP_SCHEDULE: "off",
    };
    for (const operation of ["empty database", "unchanged migrations"]) {
      execFileSync(
        process.execPath,
        [resolve(temporary, "scripts/db/migrate-runtime.mjs"), "apply"],
        {
          cwd: temporary,
          env: fixtureEnv,
          timeout: 180_000,
          stdio: "pipe",
        },
      );
      console.log(`Canonical migration with real Prisma: ${operation} passed.`);
    }
    const result = execFileSync(process.execPath, ["--import", "tsx", file, "--runtime-child"], {
      cwd: root,
      env: {
        ...fixtureEnv,
        RUNTIME_OPERATIONS_CHILD: "owned-disposable-services",
      },
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    process.stdout.write(result);
    for (const child of ["invite-race", "password-signin-race"]) {
      const authResult = execFileSync(
        process.execPath,
        ["--import", "tsx", file, "--auth-child", child],
        {
          cwd: root,
          env: {
            ...fixtureEnv,
            RUNTIME_OPERATIONS_CHILD: "owned-disposable-services",
            DATABASE_POOL_MAX: "3",
            BETTER_AUTH_URL: "https://app.example.test",
            BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
            ADMIN_EMAILS: "ops-admin@example.test",
            COCKPIT_CONTEXT_DATA_DIR: resolve(temporary, "data"),
            COCKPIT_CONTEXT_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString("base64")}`,
            SMTP_HOST: "smtp.invalid",
            SMTP_FROM: "ops@example.test",
          },
          timeout: 180_000,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        },
      );
      process.stdout.write(authResult);
    }
  } finally {
    const cleanupErrors = [];
    for (const id of containers.reverse()) {
      try {
        docker("stop", "--time", "2", id);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      console.error("Disposable fixture cleanup failed; inspect this run's owned containers.");
      process.exitCode = 1;
    } else {
      console.log("Removed only this smoke run's disposable containers and temporary fixture.");
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Runtime operations check failed.");
  process.exitCode = 1;
}
