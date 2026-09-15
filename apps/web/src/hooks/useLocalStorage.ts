import { useCallback, useState } from 'react';

/**
 * Remembers a value across reloads. Storage can be unavailable (private mode,
 * blocked site data), so every access is guarded and the in-memory value stays
 * authoritative.
 */
export function useLocalStorage(
  key: string,
  initialValue: string | null,
): [string | null, (value: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(key) ?? initialValue;
    } catch {
      return initialValue;
    }
  });

  const update = useCallback(
    (next: string | null) => {
      setValue(next);
      try {
        if (next === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, next);
      } catch {
        /* preference is not persisted; the session still works */
      }
    },
    [key],
  );

  return [value, update];
}
