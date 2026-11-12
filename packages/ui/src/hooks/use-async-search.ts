import * as React from "react";

/**
 * Debounce a changing value. Used by the async search loop so we don't fire a
 * request on every keystroke.
 */
function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/**
 * Shared async-search loop for `AsyncCombobox` and `MultiAsyncCombobox`.
 *
 * Debounces the query, fires `fetchResults` with an `AbortSignal`, and cancels
 * the in-flight request whenever the debounced query changes. This is the
 * "cancel the previous fetch on every keystroke" semantics that React Query
 * intentionally does not give us — see docs/development.md.
 *
 * Only the query re-runs the search. Callers pass `fetchResults` inline, so its
 * identity changes on every parent render; the latest one is kept in a ref and
 * used by the next search, rather than aborting and refiring on each render.
 *
 * `fetchResults` is a data fetcher, not an event-notification callback: it
 * pulls results *down* into this hook's own state (returned below), and never
 * pushes live state up to a parent.
 */
function useAsyncSearch<T>(
  fetchResults: (query: string, signal: AbortSignal) => Promise<T[]>,
  query: string,
) {
  const [results, setResults] = React.useState<T[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const debouncedQuery = useDebounce(query, 300);
  const fetchResultsRef = React.useRef(fetchResults);

  // Layout effects commit before passive ones, so the search below always
  // reads the fetcher from the render that scheduled it.
  React.useLayoutEffect(() => {
    fetchResultsRef.current = fetchResults;
  });

  React.useEffect(() => {
    const abortController = new AbortController();

    async function search() {
      setIsLoading(true);
      try {
        const data = await fetchResultsRef.current(debouncedQuery, abortController.signal);
        if (!abortController.signal.aborted) {
          setResults(data);
        }
      } catch {
        if (!abortController.signal.aborted) {
          setResults([]);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      }
    }

    search();
    return () => abortController.abort();
  }, [debouncedQuery]);

  return { results, isLoading };
}

export { useAsyncSearch, useDebounce };
