import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "../api/client.js";
import type { QueueStatusResponse } from "../api/contracts.js";
import { cancelJob, getJobStatus } from "../api/queue.js";
import { JOB_STATUS, type JobStatus, isTerminalJobStatus } from "../api/status.js";

const POLL_INTERVAL_MS = 2_000;

type BackendStatus = QueueStatusResponse["status"];

export interface QueueJobState {
  data: QueueStatusResponse | null;
  status: JobStatus;
  progress: number;
  steps: QueueStatusResponse["steps"];
  logs: unknown[];
  errors: string[];
  error: ApiError | Error | null;
  isLoading: boolean;
  isPolling: boolean;
}

export interface UseQueueJobResult {
  data: QueueStatusResponse | null;
  status: JobStatus;
  progress: number;
  steps: QueueStatusResponse["steps"];
  logs: unknown[];
  errors: string[];
  error: ApiError | Error | null;
  isLoading: boolean;
  isPolling: boolean;
  refetch: () => Promise<void>;
  cancel: () => Promise<void>;
}

const jobStateCache = new Map<string, QueueJobState>();

const EMPTY_STEPS: QueueStatusResponse["steps"] = {};

function clampProgress(progress: number | null | undefined): number {
  if (typeof progress !== "number" || Number.isNaN(progress)) return 0;
  return Math.max(0, Math.min(100, progress));
}

function normalizeStatus(status: BackendStatus): JobStatus {
  if (status === "QUEUED") return JOB_STATUS.PENDING;
  if (status === "COMPLETED") return JOB_STATUS.SUCCESS;
  if (status === "PAUSED") return JOB_STATUS.RUNNING;
  return status;
}

function toQueueJobState(payload: QueueStatusResponse): QueueJobState {
  const normalizedStatus = normalizeStatus(payload.status);
  return {
    data: payload,
    status: normalizedStatus,
    progress: clampProgress(payload.progress),
    steps: payload.steps ?? EMPTY_STEPS,
    logs: Array.isArray(payload.logs) ? payload.logs : [],
    errors: Array.isArray(payload.errors) ? payload.errors : [],
    error: null,
    isLoading: false,
    isPolling: !isTerminalJobStatus(normalizedStatus)
  };
}

function getDefaultState(): QueueJobState {
  return {
    data: null,
    status: JOB_STATUS.PENDING,
    progress: 0,
    steps: EMPTY_STEPS,
    logs: [],
    errors: [],
    error: null,
    isLoading: true,
    isPolling: false
  };
}

export function useQueueJob(jobId: string): UseQueueJobResult {
  const [state, setState] = useState<QueueJobState>(() => jobStateCache.get(jobId) ?? getDefaultState());
  const mountedRef = useRef(true);

  const runFetch = useCallback(async () => {
    setState((previous) => ({ ...previous, isLoading: previous.data === null, error: null }));

    try {
      const payload = await getJobStatus(jobId);
      const nextState = toQueueJobState(payload);
      jobStateCache.set(jobId, nextState);
      if (mountedRef.current) {
        setState(nextState);
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setState((previous) => ({
        ...previous,
        isLoading: false,
        isPolling: false,
        error: error instanceof Error ? error : new Error("Unknown queue status error")
      }));
    }
  }, [jobId]);

  const refetch = useCallback(async () => {
    await runFetch();
  }, [runFetch]);

  const cancel = useCallback(async () => {
    try {
      await cancelJob(jobId);
      if (!mountedRef.current) return;
      setState((previous) => {
        const next: QueueJobState = {
          ...previous,
          status: JOB_STATUS.CANCELLED,
          progress: previous.progress,
          errors: previous.errors,
          isPolling: false,
          isLoading: false,
          error: null,
          data: previous.data
            ? {
                ...previous.data,
                status: "CANCELLED"
              }
            : null
        };
        jobStateCache.set(jobId, next);
        return next;
      });
    } catch (error) {
      if (!mountedRef.current) return;
      setState((previous) => ({
        ...previous,
        error: error instanceof Error ? error : new Error("Unknown queue cancel error")
      }));
    }
  }, [jobId]);

  useEffect(() => {
    mountedRef.current = true;
    const cachedState = jobStateCache.get(jobId);
    if (cachedState) {
      setState(cachedState);
      if (isTerminalJobStatus(cachedState.status)) {
        return () => {
          mountedRef.current = false;
        };
      }
    } else {
      setState(getDefaultState());
    }

    void runFetch();

    const intervalId = window.setInterval(() => {
      void runFetch();
    }, POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      window.clearInterval(intervalId);
    };
  }, [jobId, runFetch]);

  useEffect(() => {
    if (!state.isPolling) return;
    if (!isTerminalJobStatus(state.status)) return;

    setState((previous) => {
      if (!previous.isPolling) return previous;
      const next = { ...previous, isPolling: false };
      jobStateCache.set(jobId, next);
      return next;
    });
  }, [jobId, state.isPolling, state.status]);

  return useMemo(
    () => ({
      data: state.data,
      status: state.status,
      progress: state.progress,
      steps: state.steps,
      logs: state.logs,
      errors: state.errors,
      error: state.error,
      isLoading: state.isLoading,
      isPolling: state.isPolling,
      refetch,
      cancel
    }),
    [cancel, refetch, state]
  );
}
