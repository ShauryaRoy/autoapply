import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError } from "../api/client.js";
import type { QueueMetricsResponse } from "../api/contracts.js";
import { getQueueMetrics } from "../api/queue.js";

export interface UseQueueMetricsResult {
  data: QueueMetricsResponse | null;
  total_jobs: number;
  success_rate: string;
  avg_execution_time: number;
  failure_reasons: Record<string, number>;
  isLoading: boolean;
  error: ApiError | Error | null;
  refetch: () => Promise<void>;
}

export function useQueueMetrics(): UseQueueMetricsResult {
  const [data, setData] = useState<QueueMetricsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const payload = await getQueueMetrics();
      setData(payload);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError : new Error("Unknown queue metrics error"));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return useMemo(
    () => ({
      data,
      total_jobs: data?.total_jobs ?? 0,
      success_rate: data?.success_rate ?? "0%",
      avg_execution_time: data?.avg_execution_time_ms ?? 0,
      failure_reasons: data?.failure_reasons ?? {},
      isLoading,
      error,
      refetch
    }),
    [data, error, isLoading, refetch]
  );
}
