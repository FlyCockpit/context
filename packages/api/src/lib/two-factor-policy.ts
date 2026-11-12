import {
  FORCE_2FA_SETTING_KEYS,
  forcedTwoFactorSettingKeyForRole,
  isForcedTwoFactorEnabled,
  isTwoFactorRequirementSatisfied,
  type TwoFactorPolicyUser,
} from "@cockpit-context/auth/two-factor-policy";
import prisma from "@cockpit-context/db";

// The keys, the absent-row defaults, and the grace window live in
// `@cockpit-context/auth/two-factor-policy` so the browser mirror
// (`apps/web/src/utils/two-factor-policy.ts`) reads the same literals. This
// module adds only the database read and its cache.
export { FORCE_2FA_SETTING_KEYS } from "@cockpit-context/auth/two-factor-policy";

// In-process TTL cache for the force-2FA settings. `requireAdmin` /
// `requireRequiredTwoFactor` consult this on nearly every protected call, so
// hitting Postgres each time is pure overhead for a value that changes only
// when an admin flips the setting. The settings write path calls
// `invalidateForceTwoFactorSettingsCache()` for same-process immediacy; other
// processes converge within the TTL.
const FORCE_2FA_CACHE_TTL_MS = 60_000;

let cacheGeneration = 0;

let forceTwoFactorCache: { byKey: Map<string, string>; expiresAt: number } | null = null;

async function loadForceTwoFactorSettings(): Promise<Map<string, string>> {
  const now = Date.now();
  if (forceTwoFactorCache && forceTwoFactorCache.expiresAt > now) {
    return forceTwoFactorCache.byKey;
  }
  const generation = cacheGeneration;
  const settings = await prisma.appSetting.findMany({
    where: {
      key: {
        in: [...FORCE_2FA_SETTING_KEYS],
      },
    },
    select: { key: true, value: true },
    // pagination:audited — bounded by the compile-time settings key list
    take: FORCE_2FA_SETTING_KEYS.length,
  });
  if (generation !== cacheGeneration) return loadForceTwoFactorSettings();
  const byKey = new Map(settings.map((setting) => [setting.key, setting.value]));
  forceTwoFactorCache = { byKey, expiresAt: now + FORCE_2FA_CACHE_TTL_MS };
  return byKey;
}

/** Drop the cached settings — call after any AppSetting write to these keys (and from test setup). */
export function invalidateForceTwoFactorSettingsCache(): void {
  cacheGeneration += 1;
  forceTwoFactorCache = null;
}

/**
 * Is forced 2FA on for this role? An absent AppSetting row resolves to
 * `FORCE_2FA_DEFAULTS` — which means **on** for internal (admin) users.
 */
export async function isForcedTwoFactorEnabledForRole(role: unknown): Promise<boolean> {
  const targetKey = forcedTwoFactorSettingKeyForRole(role);
  const byKey = await loadForceTwoFactorSettings();

  return isForcedTwoFactorEnabled(targetKey, byKey.get(targetKey));
}

/**
 * The gate every server-side caller uses. Pass the whole session user — the
 * `createdAt` field is load-bearing, because an unenrolled user inside the
 * enrollment grace window still satisfies the policy. A missing or unreadable
 * `createdAt` means no grace (fail closed).
 */
export async function isTwoFactorPolicySatisfied(
  user: TwoFactorPolicyUser & { role?: unknown },
): Promise<boolean> {
  if (user.twoFactorEnabled) return true;
  const forced = await isForcedTwoFactorEnabledForRole(user.role);
  return isTwoFactorRequirementSatisfied(user, forced);
}
