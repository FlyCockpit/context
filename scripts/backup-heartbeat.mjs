#!/usr/bin/env node
/**
 * Optional dead-man's-switch ping after a verified off-site upload. The new
 * pre-migration hook and scheduler use backup/s3.mjs's upload CLI, which calls
 * this only after uploadBackup succeeds (including a retry of the same dump).
 * Local-only dumps never send a heartbeat. Ping failures cannot fail a backup.
 * Network error text may contain the token-bearing URL; never log it.
 */
import { fileURLToPath } from "node:url";

export async function sendBackupHeartbeat({
  raw = process.env.BACKUP_HEARTBEAT_URL,
  fetcher = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
  warn = console.error,
} = {}) {
  if (!raw) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    warn("WARNING: BACKUP_HEARTBEAT_URL is not a valid URL; no heartbeat sent.");
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    warn("WARNING: BACKUP_HEARTBEAT_URL must use HTTP or HTTPS; no heartbeat sent.");
    return false;
  }
  let failure = "request failed";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetcher(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "error",
      });
      // Release the body even on a non-2xx response before retrying.
      await response.body?.cancel();
      if (response.ok) {
        log("Backup heartbeat sent.");
        return true;
      }
      failure = `HTTP ${response.status}`;
    } catch {
      failure = "request failed or timed out";
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await sleep((attempt + 1) * 1000);
  }
  warn(
    `WARNING: backup heartbeat failed after 3 attempts (${failure}). The uploaded dump is safe.`,
  );
  return false;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await sendBackupHeartbeat();
