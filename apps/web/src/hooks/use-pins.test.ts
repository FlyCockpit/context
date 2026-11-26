import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/orpc", () => ({ orpc: {} }));
vi.mock("@/hooks/use-entity-mutation", () => ({ useEntityMutation: vi.fn() }));

const { pinOrderSaver } = await import("./use-pins");
type PinsData = import("./use-pins").PinsData;

const KEY = ["pins", "list"];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

function list(ids: string[]): PinsData {
  return { items: ids.map((id) => ({ id })), limit: 12 } as unknown as PinsData;
}

function cached(client: QueryClient) {
  return client.getQueryData<PinsData>(KEY)?.items.map((item) => item.id);
}

describe("pinOrderSaver", () => {
  it("keeps the last acknowledged order when a re-read from before it lands late and the next save fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(KEY, list(["a", "b", "c"]));

    const sends: { resolve: () => void; reject: (error: Error) => void }[] = [];
    const saver = pinOrderSaver(client, KEY, () => {
      const gate = deferred<void>();
      sends.push(gate);
      return gate.promise;
    });

    saver.save(["b", "a", "c"]);
    saver.save(["b", "c", "a"]);

    // A background re-read starts before the first save is acknowledged and
    // would answer with the old order.
    const read = deferred<PinsData>();
    const late = client
      .fetchQuery({ queryKey: KEY, queryFn: () => read.promise, staleTime: 0 })
      .catch(() => undefined);

    sends[0]?.resolve();
    await settle();
    expect(cached(client)).toEqual(["b", "a", "c"]);

    // The stale read answers after the acknowledgement: it must not win.
    read.resolve(list(["a", "b", "c"]));
    await late;
    await settle();
    expect(cached(client)).toEqual(["b", "a", "c"]);

    // The queued save fails (offline): the overlay goes, the acknowledged order stays.
    client.setQueryDefaults(KEY, { queryFn: () => new Promise<PinsData>(() => undefined) });
    sends[1]?.reject(new Error("offline"));
    await settle();
    expect(saver.desired()).toBeNull();
    expect(cached(client)).toEqual(["b", "a", "c"]);
    client.clear();
  });

  it("writes each acknowledged order and re-reads once the queue drains", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(KEY, list(["a", "b"]));
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
    const saver = pinOrderSaver(client, KEY, () => Promise.resolve());
    saver.save(["b", "a"]);
    await settle();
    expect(cached(client)).toEqual(["b", "a"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
    client.clear();
  });
});
