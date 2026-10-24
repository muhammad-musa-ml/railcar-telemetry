import { useCallback, useEffect, useState } from "react";
import { errorText, getJson } from "./api";

export interface Polled<T> {
  data: T | null;
  // The last request failed. `data` then still holds the last answer that
  // arrived, from `updatedAt`.
  error: string | null;
  updatedAt: Date | null;
  loading: boolean;
  refresh: () => void;
}

interface State<T> {
  path: string | null;
  data: T | null;
  error: string | null;
  updatedAt: Date | null;
}

// Fetches `path` now and again `intervalMs` after each answer, until the
// component goes away or the path changes. A null path fetches nothing.
// An answer for an earlier path, or one that arrives after the component
// is gone, is dropped.
export function usePolling<T>(path: string | null, intervalMs: number): Polled<T> {
  const [state, setState] = useState<State<T>>({ path, data: null, error: null, updatedAt: null });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // A new path starts empty rather than showing the previous path's answer.
  if (state.path !== path) {
    setState({ path, data: null, error: null, updatedAt: null });
  }

  useEffect(() => {
    if (path === null) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    getJson<T>(path, controller.signal)
      .then(
        (data) => {
          if (!controller.signal.aborted) setState({ path, data, error: null, updatedAt: new Date() });
        },
        (err: unknown) => {
          if (!controller.signal.aborted) setState((s) => ({ ...s, path, error: errorText(err) }));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) timer = setTimeout(() => setTick((t) => t + 1), intervalMs);
      });
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [path, intervalMs, tick]);

  const current = state.path === path ? state : { data: null, error: null, updatedAt: null };
  return {
    data: current.data,
    error: current.error,
    updatedAt: current.updatedAt,
    loading: path !== null && current.data === null && current.error === null,
    refresh,
  };
}
