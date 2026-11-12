import { z } from "zod";

/** Opaque entity primary key (cuid2-ish). */
export const entityId = z.string().min(1).max(64);

/**
 * Short user-facing string: titles, names, one-line labels.
 *
 * Trimmed and non-empty. A name these schemas describe as "text" must not
 * accept `""` or `"   "` — a blank title renders as an empty row the user
 * cannot see or click, and every caller so far would have had to re-add the
 * check itself. Fields that are genuinely optional should say so with
 * `.optional()` rather than by allowing an empty string.
 */
export const shortText = z.string().trim().min(1).max(200);

/** Long user-facing string: bodies, descriptions, markdown. Trimmed, non-empty. */
export const longText = z.string().trim().min(1).max(10_000);

/**
 * Opaque pagination cursor token — string bounds only. The format check lives
 * in `pagination.ts` (`cursorTokenSchema`), which is what procedure inputs use.
 */
export const cursorToken = z.string().trim().min(1).max(128);
