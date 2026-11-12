import prisma from "@cockpit-context/db";
import { ADMIN_EMAILS, SIGNUP_ENABLED } from "@cockpit-context/env/server";

import { isBootstrapTokenActive } from "./bootstrap-token.js";
import { isAdminRole } from "./roles.js";
import {
  type AdminSetupState,
  resolveAdminBootstrapOpen,
  resolveAdminSetupState,
  resolveSignupOpen,
  SIGNUP_OPEN_SETTING_KEY,
} from "./signup-policy.js";

// Server-side half of the signup policy: the AppSetting read and the admin
// existence check, each behind a short in-process TTL cache. `appConfig` is
// public and the signup gate runs on every sign-up request, so neither may hit
// Postgres per call. Cockpit Context runs exactly one replica (docs/hosting.md), and
// `settings.update` calls `invalidateSignupAvailabilityCache()` after a write,
// so the toggle takes effect immediately.
const CACHE_TTL_MS = 60_000;

let cacheGeneration = 0;

let signupOpenCache: { value: boolean; expiresAt: number } | null = null;
let adminExistsCache: { value: boolean; expiresAt: number } | null = null;
let usersExistCache: { value: boolean; expiresAt: number } | null = null;

/** Drop the cached values — call after writing the signup setting (and from test setup). */
export function invalidateSignupAvailabilityCache(): void {
  cacheGeneration += 1;
  signupOpenCache = null;
  adminExistsCache = null;
  usersExistCache = null;
}

/** Effective open signup: `SIGNUP_ENABLED` AND the admin's `signupOpen` AppSetting. */
export async function isSignupOpen(): Promise<boolean> {
  // The env flag is the ceiling: when it is off there is nothing to read.
  if (!SIGNUP_ENABLED) return false;
  const now = Date.now();
  if (signupOpenCache && signupOpenCache.expiresAt > now) return signupOpenCache.value;
  const generation = cacheGeneration;
  const row = await prisma.appSetting.findUnique({
    where: { key: SIGNUP_OPEN_SETTING_KEY },
    select: { value: true },
  });
  const value = resolveSignupOpen(SIGNUP_ENABLED, row?.value);
  if (generation !== cacheGeneration) return isSignupOpen();
  signupOpenCache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

// Roles are a comma-separated free-form string (Better-Auth admin plugin).
// `contains` over-matches on purpose and `isAdminRole` decides; Cockpit Context only ever
// assigns "user" or "admin", so the bound is never reached in practice.
const ADMIN_CANDIDATE_LIMIT = 50;

async function queryAnyAdmin(): Promise<boolean> {
  const candidates = await prisma.user.findMany({
    where: { role: { contains: "admin", mode: "insensitive" } },
    select: { role: true },
    take: ADMIN_CANDIDATE_LIMIT,
  });
  return candidates.some((candidate) => isAdminRole(candidate.role));
}

/**
 * Does any admin account exist? `fresh` skips the cache — the user-create
 * hook is the authorization boundary and must not act on a stale `false`.
 */
export async function hasAnyAdmin(opts: { fresh?: boolean } = {}): Promise<boolean> {
  const now = Date.now();
  if (!opts.fresh && adminExistsCache && adminExistsCache.expiresAt > now) {
    return adminExistsCache.value;
  }
  const generation = cacheGeneration;
  const value = await queryAnyAdmin();
  if (generation !== cacheGeneration) return hasAnyAdmin(opts);
  adminExistsCache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/**
 * Does any account exist? `fresh` skips the cache — the user-create hook is the
 * authorization boundary for the first-admin bootstrap.
 */
export async function hasAnyUser(opts: { fresh?: boolean } = {}): Promise<boolean> {
  const now = Date.now();
  if (!opts.fresh && usersExistCache && usersExistCache.expiresAt > now) {
    return usersExistCache.value;
  }
  const generation = cacheGeneration;
  // pagination:audited — bounded by take: 1 (existence check)
  const value = (await prisma.user.findFirst({ select: { id: true } })) !== null;
  if (generation !== cacheGeneration) return hasAnyUser(opts);
  usersExistCache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export type SignupAvailability = {
  /** Anyone may self-register. */
  signupOpen: boolean;
  /** An ADMIN_EMAILS address with the boot-log token may create the first (admin) account. */
  adminBootstrapOpen: boolean;
  /** Set only while no admin exists: what the sign-in/sign-up pages should explain. */
  adminSetup: AdminSetupState;
};

/**
 * What the sign-up surface currently accepts. Request-independent on purpose:
 * it never looks at the submitted address, so acting on it cannot reveal
 * whether an address is on the admin allowlist (see apps/server/src/signup-gate.ts).
 */
export async function getSignupAvailability(): Promise<SignupAvailability> {
  const [signupOpen, adminExists] = await Promise.all([isSignupOpen(), hasAnyAdmin()]);
  // An admin implies an account: skip the second read.
  const usersExist = adminExists || (await hasAnyUser());
  const adminBootstrapOpen = resolveAdminBootstrapOpen({
    adminEmailCount: ADMIN_EMAILS.size,
    usersExist,
    tokenActive: isBootstrapTokenActive(),
  });
  return {
    signupOpen,
    adminBootstrapOpen,
    adminSetup: resolveAdminSetupState({ adminExists, adminBootstrapOpen, usersExist }),
  };
}
