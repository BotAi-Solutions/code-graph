import { useCallback, useEffect, useRef, useState } from 'react';
import { getAnalysis, startAnalysis } from '../api/projects.api.js';
import { errorMessage } from './useAsync.js';
import type { AnalysisJob } from '../types/index.js';

const TERMINAL: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED']);
const POLL_INTERVAL_MS = 1000;

/**
 * Starts an analysis and follows it to completion.
 *
 * Analysis is asynchronous by design — the API returns a queued job and the
 * worker does the work — so the UI polls rather than waiting on a request.
 */
export function useAnalysis(projectId: string | null, onCompleted: () => void) {
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  // A new project means the previous job is no longer relevant.
  useEffect(() => {
    setJob(null);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !job || TERMINAL.has(job.status)) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      getAnalysis(projectId, job.id)
        .then((next) => {
          if (cancelled) return;
          setJob(next);
          if (next.status === 'COMPLETED') onCompletedRef.current();
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(errorMessage(cause));
        });
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, job]);

  const start = useCallback(async () => {
    if (!projectId) return;
    setStarting(true);
    setError(null);
    try {
      setJob(await startAnalysis(projectId));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStarting(false);
    }
  }, [projectId]);

  const running = job !== null && !TERMINAL.has(job.status);

  return { job, error, starting, running, start, setJob };
}
