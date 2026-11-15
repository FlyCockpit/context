import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";

// The MCP plugins import the Prisma client for grant bookkeeping; nothing in
// these tests reaches it (the guard refuses first, or the provider refuses
// the unsigned query), so an empty mock is enough to keep import IO out.
vi.mock("@cockpit-context/db", () => ({ default: {} }));

const { announceIfUserBanned, onUserBanned } = await import("./ban");
const { BANNED_SESSION_ALLOWED_PATHS, bannedSessionGuard } = await import("./banned-session-guard");
const { resolveMcpPlugins } = await import("./mcp-plugins");

const BASE = "http://localhost:3000";
const PASSWORD = "correct-horse-battery";

// Cheap deterministic hash: the guard does not depend on it (see
// user-create-hook.test.ts for why scrypt made these tests load-sensitive).
const fastPassword = {
  hash: async (password: string) =>
    `test-sha256:${createHash("sha256").update(password).digest("hex")}`,
  verify: async ({ hash, password }: { hash: string; password: string }) =>
    hash === `test-sha256:${createHash("sha256").update(password).digest("hex")}`,
};

type Row = Record<string, unknown>;

function buildAuth(opts: { cookieCache?: boolean } = {}) {
  const db: Record<string, Row[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    oauthClient: [],
    oauthRefreshToken: [],
    oauthAccessToken: [],
    oauthConsent: [],
  };
  const auth = betterAuth({
    database: memoryAdapter(db),
    secret: "test-secret-that-is-long-enough-for-better-auth-0123456789",
    baseURL: BASE,
    logger: { disabled: true },
    rateLimit: { enabled: false },
    emailAndPassword: { enabled: true, minPasswordLength: 12, password: fastPassword },
    session: opts.cookieCache ? { cookieCache: { enabled: true, maxAge: 60 } } : {},
    // Mirrors packages/auth/src/index.ts: the guard first, then the rest.
    plugins: [
      bannedSessionGuard(),
      admin({ defaultRole: "user" }),
      ...resolveMcpPlugins({
        baseUrl: BASE,
        secret: "test-secret-that-is-long-enough-for-better-auth-0123456789",
      }),
    ],
    databaseHooks: {
      user: {
        update: {
          after: async (user) => {
            announceIfUserBanned(user);
          },
        },
      },
    },
  });
  return { auth, db };
}

type Auth = ReturnType<typeof buildAuth>["auth"];

/** Signs up, returns the Cookie header the browser would send next. */
async function signedIn(auth: Auth, email: string): Promise<{ cookie: string; userId: string }> {
  const result = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: "Someone" },
    returnHeaders: true,
  });
  const cookie = result.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  return { cookie, userId: result.response.user.id };
}

function post(path: string, cookie: string, body: unknown = {}): Request {
  return new Request(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { cookie, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie: string): Request {
  return new Request(`${BASE}/api/auth${path}`, { headers: { cookie, origin: BASE } });
}

/** A ban written straight to the row: the session survives it. */
function banInPlace(db: Record<string, Row[]>, userId: string, banExpires: Date | null = null) {
  const user = db.user?.find((row) => row.id === userId);
  if (!user) throw new Error("no such user");
  user.banned = true;
  user.banExpires = banExpires;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bannedSessionGuard", () => {
  it("lets a user who is not banned update their profile", async () => {
    const { auth, db } = buildAuth();
    const { cookie, userId } = await signedIn(auth, "ok@example.com");
    const response = await auth.handler(post("/update-user", cookie, { name: "Renamed" }));
    expect(response.status).toBe(200);
    expect(db.user?.find((row) => row.id === userId)?.name).toBe("Renamed");
  });

  it("refuses a profile update on a banned user's surviving session", async () => {
    const { auth, db } = buildAuth();
    const { cookie, userId } = await signedIn(auth, "banned@example.com");
    banInPlace(db, userId);

    const response = await auth.handler(post("/update-user", cookie, { name: "Renamed" }));
    expect(response.status).toBe(401);
    expect(db.user?.find((row) => row.id === userId)?.name).toBe("Someone");
  });

  it("refuses OAuth consent and continue on a banned user's surviving session", async () => {
    const { auth, db } = buildAuth();
    const healthy = await signedIn(auth, "healthy@example.com");

    for (const [path, body] of [
      ["/oauth2/consent", { accept: true, oauth_query: "client_id=c&sig=x" }],
      ["/oauth2/continue", { selected: true, oauth_query: "client_id=c&sig=x" }],
    ] as const) {
      // One banned user per path: a refusal deletes that user's sessions.
      const banned = await signedIn(auth, `banned${path.replaceAll("/", "-")}@example.com`);
      banInPlace(db, banned.userId);
      const refused = await auth.handler(post(path, banned.cookie, body));
      expect(refused.status, path).toBe(401);

      // The same request on a healthy session reaches the OAuth provider,
      // which refuses the unsigned query on its own terms: the 401 above is
      // the guard's, not the endpoint's.
      const reached = await auth.handler(post(path, healthy.cookie, body));
      expect(reached.status, path).not.toBe(401);
      expect(reached.status, path).toBeGreaterThanOrEqual(400);
    }
    expect(db.oauthConsent).toHaveLength(0);
  });

  it("refuses get-session with a 401, which the web maps to signed out", async () => {
    const { auth, db } = buildAuth();
    const { cookie, userId } = await signedIn(auth, "banned@example.com");
    expect((await auth.handler(get("/get-session", cookie))).status).toBe(200);
    banInPlace(db, userId);
    expect((await auth.handler(get("/get-session", cookie))).status).toBe(401);
  });

  it("fails closed when the session lookup itself fails, instead of passing the request on", async () => {
    const { auth, db } = buildAuth();
    const { cookie, userId } = await signedIn(auth, "flaky@example.com");
    banInPlace(db, userId);
    const context = await auth.$context;
    const findSession = context.internalAdapter.findSession;
    // The guard's lookup fails; the endpoint's own lookup would succeed.
    context.internalAdapter.findSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockImplementation(findSession);
    try {
      const response = await auth.handler(post("/update-user", cookie, { name: "Renamed" }));
      expect(response.status).not.toBe(200);
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      context.internalAdapter.findSession = findSession;
    }
    expect(db.user?.find((row) => row.id === userId)?.name).toBe("Someone");
  });

  it("deletes the banned user's surviving sessions when it refuses one", async () => {
    const { auth, db } = buildAuth();
    const first = await signedIn(auth, "two-tabs@example.com");
    const second = await auth.api.signInEmail({
      body: { email: "two-tabs@example.com", password: PASSWORD },
    });
    expect(second.token).toEqual(expect.any(String));
    expect(db.session?.filter((row) => row.userId === first.userId)).toHaveLength(2);
    banInPlace(db, first.userId);

    expect((await auth.handler(get("/get-session", first.cookie))).status).toBe(401);
    expect(db.session?.filter((row) => row.userId === first.userId)).toHaveLength(0);
  });

  it("still lets the banned session sign out, which deletes it", async () => {
    expect([...BANNED_SESSION_ALLOWED_PATHS]).toEqual(["/sign-out"]);
    const { auth, db } = buildAuth();
    const { cookie, userId } = await signedIn(auth, "banned@example.com");
    banInPlace(db, userId);

    const response = await auth.handler(post("/sign-out", cookie));
    expect(response.status).toBe(200);
    expect(db.session?.filter((row) => row.userId === userId)).toHaveLength(0);
  });

  it("lets a lapsed temporary ban through", async () => {
    const { auth, db } = buildAuth();
    const { cookie, userId } = await signedIn(auth, "lapsed@example.com");
    banInPlace(db, userId, new Date(Date.now() - 60_000));
    const response = await auth.handler(post("/update-user", cookie, { name: "Back" }));
    expect(response.status).toBe(200);
  });

  it("does not throw inside server-side auth.api calls, which apply the ban themselves", async () => {
    const { auth, db } = buildAuth();
    const { cookie, userId } = await signedIn(auth, "banned@example.com");
    banInPlace(db, userId);
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user).toMatchObject({ id: userId, banned: true });
  });

  it("takes effect once the signed cookie cache (60 s) lapses, not before", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-14T12:00:00Z") });
    const { auth, db } = buildAuth({ cookieCache: true });
    const { cookie, userId } = await signedIn(auth, "cached@example.com");
    banInPlace(db, userId);

    // The cache cookie was signed before the ban: it still says "not banned".
    expect((await auth.handler(get("/get-session", cookie))).status).toBe(200);

    vi.setSystemTime(new Date("2026-11-14T12:01:01Z"));
    expect((await auth.handler(post("/update-user", cookie, { name: "Late" }))).status).toBe(401);
  });
});

describe("plugin ban paths", () => {
  async function adminAndTarget() {
    const built = buildAuth();
    const adminUser = await signedIn(built.auth, "admin@example.com");
    const adminRow = built.db.user?.find((row) => row.id === adminUser.userId);
    if (adminRow) adminRow.role = "admin";
    const target = await signedIn(built.auth, "target@example.com");
    return { ...built, adminUser, target };
  }

  it("/admin/ban-user deletes the target's sessions and announces the ban", async () => {
    const { auth, db, adminUser, target } = await adminAndTarget();
    const announced: string[] = [];
    const stop = onUserBanned((userId) => announced.push(userId));
    try {
      const response = await auth.handler(
        post("/admin/ban-user", adminUser.cookie, { userId: target.userId }),
      );
      expect(response.status).toBe(200);
    } finally {
      stop();
    }
    expect(db.session?.filter((row) => row.userId === target.userId)).toHaveLength(0);
    expect(announced).toEqual([target.userId]);
  });

  it("/admin/update-user with banned: true deletes sessions and announces; other updates do not announce", async () => {
    const { auth, db, adminUser, target } = await adminAndTarget();
    const announced: string[] = [];
    const stop = onUserBanned((userId) => announced.push(userId));
    try {
      const renamed = await auth.handler(
        post("/admin/update-user", adminUser.cookie, {
          userId: target.userId,
          data: { name: "Renamed" },
        }),
      );
      expect(renamed.status).toBe(200);
      expect(announced).toEqual([]);

      const banned = await auth.handler(
        post("/admin/update-user", adminUser.cookie, {
          userId: target.userId,
          data: { banned: true },
        }),
      );
      expect(banned.status).toBe(200);
    } finally {
      stop();
    }
    expect(db.session?.filter((row) => row.userId === target.userId)).toHaveLength(0);
    expect(announced).toEqual([target.userId]);
  });
});
