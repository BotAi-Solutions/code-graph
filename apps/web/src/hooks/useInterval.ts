import { useEffect, useRef } from 'react';

/**
 * Runs `callback` every `delayMs` while `delayMs` is non-null.
 *
 * The callback lives in a ref so a changing closure does not restart the timer —
 * otherwise a listing that refreshes on each tick would reset its own interval
 * every time and drift.
 */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const saved = useRef(callback);
  saved.current = callback;

  useEffect(() => {
    if (delayMs === null) return;
    const id = setInterval(() => {
      saved.current();
    }, delayMs);
    return () => {
      clearInterval(id);
    };
  }, [delayMs]);
}
