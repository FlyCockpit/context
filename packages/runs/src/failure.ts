import { isRepoError } from "@cockpit-context/repos";

import type { RunFailure } from "./events";

/** Most nearest tags a failure carries (as the API's domain errors). */
const MAX_NEAREST_TAGS = 10;

/**
 * The owner-visible projection of a resolution error: the RepoError code and
 * its allowlisted details only (git output stays in the run's `error`,
 * server-side). Anything that is not a RepoError has no safe detail: null.
 */
export function runFailureFrom(error: unknown): RunFailure | null {
  if (!isRepoError(error)) return null;
  const failure: RunFailure = { reason: error.code };
  if (error.details.nearestTags?.length) {
    failure.nearestTags = error.details.nearestTags.slice(0, MAX_NEAREST_TAGS);
  }
  if (error.code === "HOST_KEY_UNCONFIRMED") {
    if (error.details.host) failure.host = error.details.host;
    if (error.details.port) failure.port = error.details.port;
  }
  return failure;
}

/**
 * A stored `AgentRun.failure` read back for the client, allowlisted again
 * field by field (the column is JSON: never trusted to have one shape).
 */
export function runFailureFromJson(value: unknown): RunFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.reason !== "string" || !/^[A-Z_]{1,64}$/.test(record.reason)) return null;
  const failure: RunFailure = { reason: record.reason };
  if (Array.isArray(record.nearestTags)) {
    const tags = record.nearestTags
      .filter((tag): tag is string => typeof tag === "string" && tag.length <= 250)
      .slice(0, MAX_NEAREST_TAGS);
    if (tags.length > 0) failure.nearestTags = tags;
  }
  if (typeof record.host === "string" && record.host.length <= 253) failure.host = record.host;
  if (typeof record.port === "number" && Number.isInteger(record.port)) failure.port = record.port;
  return failure;
}
