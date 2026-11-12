import prisma from "@cockpit-context/db";
import { z } from "zod";
import type { FreshnessStore } from "./backup-freshness";

const envelopeSchema = z.object({ expiresAt: z.string(), value: z.string() });

/**
 * The backup-freshness verdict cache, in Postgres (`AppSetting`). It replaced a
 * Redis `SET … EX`; the TTL is carried inside the stored envelope, and an
 * expired or unreadable envelope reads back as `null` (unknown), never as the
 * stale value. One row per backup target (`backupFreshnessKey()`), overwritten
 * on every check, so the table does not grow with the number of runs.
 */
export const appSettingFreshnessStore: FreshnessStore = {
  async get(key) {
    const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
    if (!row) return null;
    try {
      const envelope = envelopeSchema.parse(JSON.parse(row.value));
      const expiresAt = Date.parse(envelope.expiresAt);
      if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) return null;
      return envelope.value;
    } catch {
      return null;
    }
  },
  async set(key, value, ttlSeconds) {
    const envelope = JSON.stringify({
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      value,
    });
    await prisma.appSetting.upsert({
      where: { key },
      update: { value: envelope },
      create: { key, value: envelope },
    });
  },
};
