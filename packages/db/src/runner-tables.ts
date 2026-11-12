/**
 * Names for the tables the production migration runner owns
 * (`_cockpit_context_migration`, `_cockpit_context_instance`, … — created by
 * scripts/db/lib/contracts.mjs). They are not Prisma models, so raw queries
 * name them through here.
 */
import { env } from "@cockpit-context/env/shared";

import { Prisma } from "../prisma/generated/client";

/**
 * The schema the runner creates its tables in: DATABASE_URL's `?schema=`,
 * else `public` — the same rule as `prismaSchemaName` in
 * scripts/db/lib/migration-state.mjs.
 */
export function runnerSchema(): string {
  try {
    return new URL(env.DATABASE_URL).searchParams.get("schema") || "public";
  } catch {
    return "public";
  }
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The schema-qualified, quoted name of one runner-owned table. */
export function runnerTable(name: string): Prisma.Sql {
  return Prisma.raw(`${quoteIdent(runnerSchema())}.${quoteIdent(name)}`);
}
