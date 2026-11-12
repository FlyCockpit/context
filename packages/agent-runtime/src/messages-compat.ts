/**
 * Request-body fixes for the messages API behind OpenRouter-style gateways.
 *
 * `@tanstack/ai-anthropic` sends every custom tool with `cache_control: null` when the tool
 * carries no breakpoint. Anthropic reads `null` as "no breakpoint", but OpenRouter's
 * Messages validator rejects the whole request (`Unknown server-tool shorthand`). Since
 * only the last tool gets a breakpoint, every request with two or more tools fails there.
 * Dropping the `null`s keeps the meaning and passes both validators.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dropNullCacheControl = (items: unknown): boolean => {
  if (!Array.isArray(items)) return false;
  let changed = false;
  for (const item of items) {
    if (isRecord(item) && "cache_control" in item && item.cache_control === null) {
      delete item.cache_control;
      changed = true;
    }
  }
  return changed;
};

/**
 * Remove `cache_control: null` from the tools and system blocks of a Messages request,
 * in place. Returns whether anything changed.
 */
export const stripNullCacheControl = (body: unknown): boolean => {
  if (!isRecord(body)) return false;
  const tools = dropNullCacheControl(body.tools);
  const system = dropNullCacheControl(body.system);
  return tools || system;
};

/** A `fetch` for the Anthropic SDK that applies {@link stripNullCacheControl}. */
export const messagesFetch =
  (base: typeof fetch = globalThis.fetch): typeof fetch =>
  (input, init) => {
    if (typeof init?.body !== "string") return base(input, init);
    let payload: unknown;
    try {
      payload = JSON.parse(init.body);
    } catch {
      return base(input, init);
    }
    if (!stripNullCacheControl(payload)) return base(input, init);
    return base(input, { ...init, body: JSON.stringify(payload) });
  };
