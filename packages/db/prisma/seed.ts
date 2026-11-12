// Database seed logic.
//
// This file exports `runSeed()` so the SAME function can be invoked two ways
// without duplicating logic:
//
//   1. CLI    — `pnpm db:seed` (`prisma db seed`) → prisma/seed.cli.ts calls
//      runSeed(); `pnpm db:seed -- --email you@example.com` picks the owner.
//   2. Inline — the admin "Run seed" button (`seed.run`, packages/api) awaits
//      runSeed({ ownerId }) inside the request for the acting admin.
//
// What it seeds: Cockpit Context's development demo data (./seed-demo.ts) — packages,
// proposals, an MCP token, repository/checkout rows and finished
// conversations — owned by ONE existing user, because only a conversation's
// owner can ever read it (docs/access-matrix.md). It never creates
// users: sign up first, then seed.
//
// Rules this keeps:
//   * IDEMPOTENT — every row is found by a natural key before it is created.
//   * SHORT — a few dozen inserts; the admin path blocks the request.
//   * DEVELOPMENT ONLY — NODE_ENV=production seeds nothing (the admin page's
//     "SEED PRODUCTION" phrase then only reports that).
//   * One human-readable `summary` line per step, rendered in the admin UI.
//
// Reuses the shared, adapter-configured Prisma client. Do NOT call
// `$disconnect()` here — the client is shared with the server process. The CLI
// wrapper (seed.cli.ts) owns disconnect for the standalone case.
import { env } from "@cockpit-context/env/server";

import prisma from "../src/index";
import { seedDemoData } from "./seed-demo";

export type SeedResult = {
  /** One line per thing the seed did, rendered verbatim in the admin UI. */
  summary: string[];
};

export type SeedOptions = {
  /** Owner of the demo data (the admin path passes the acting admin). */
  ownerId?: string;
  /** Owner by email (the CLI's `--email`). Default: the first admin, else the first user. */
  ownerEmail?: string;
};

const ownerSelect = { id: true, email: true } as const;

async function resolveOwner(options: SeedOptions) {
  if (options.ownerId) {
    return prisma.user.findUnique({ where: { id: options.ownerId }, select: ownerSelect });
  }
  if (options.ownerEmail) {
    return prisma.user.findUnique({ where: { email: options.ownerEmail }, select: ownerSelect });
  }
  return (
    (await prisma.user.findFirst({
      where: { role: { contains: "admin" } },
      orderBy: { createdAt: "asc" },
      select: ownerSelect,
    })) ?? (await prisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: ownerSelect }))
  );
}

export async function runSeed(options: SeedOptions = {}): Promise<SeedResult> {
  const summary: string[] = [];

  if (env.NODE_ENV === "production") {
    summary.push("Skipped the demo data: it is development-only and NODE_ENV is production.");
    return { summary };
  }

  const owner = await resolveOwner(options);
  if (!owner) {
    summary.push(
      options.ownerEmail
        ? `No user with email ${options.ownerEmail}; nothing seeded.`
        : "No users yet: sign up first, then run the seed again.",
    );
    return { summary };
  }
  summary.push(`Seeding demo data for ${owner.email}`);

  summary.push(
    ...(await seedDemoData({
      ownerId: owner.id,
      betterAuthSecret: env.BETTER_AUTH_SECRET,
      // Development only (checked above): the one place the plaintext appears.
      revealSecret: (line) => console.log(`[seed] ${line}`),
    })),
  );

  return { summary };
}
