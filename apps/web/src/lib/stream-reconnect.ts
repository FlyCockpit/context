/**
 * Keep an oRPC event-iterator subscription open: consume it, and when it
 * ends or fails (a deploy, a sleeping laptop, a proxy dropping an idle
 * connection, `EventBusOverflowError` for a subscriber that fell behind),
 * subscribe again after a capped exponential backoff. Every
 * (re)subscription starts with a fresh snapshot from the server, so nothing
 * is lost across the gap.
 *
 * Stops for good when `signal` aborts or `isFatal(error)` says retrying is
 * pointless (the conversation is gone, the session ended).
 */

export type StreamStatus = "connecting" | "live" | "reconnecting" | "failed";

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt));
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function consumeWithReconnect<T>(options: {
  signal: AbortSignal;
  connect: (signal: AbortSignal) => Promise<AsyncIterable<T>>;
  onEvent: (event: T) => void;
  onStatus: (status: StreamStatus, error?: unknown) => void;
  isFatal?: (error: unknown) => boolean;
}): Promise<void> {
  const { signal } = options;
  let attempt = 0;
  options.onStatus("connecting");
  while (!signal.aborted) {
    try {
      const events = await options.connect(signal);
      let first = true;
      for await (const event of events) {
        if (signal.aborted) return;
        // The first event (a snapshot, a ready marker) means the subscription is up.
        if (first) options.onStatus("live");
        first = false;
        attempt = 0;
        options.onEvent(event);
      }
    } catch (error) {
      if (signal.aborted) return;
      if (options.isFatal?.(error)) {
        options.onStatus("failed", error);
        return;
      }
    }
    if (signal.aborted) return;
    options.onStatus("reconnecting");
    await wait(reconnectDelay(attempt), signal);
    attempt += 1;
  }
}
