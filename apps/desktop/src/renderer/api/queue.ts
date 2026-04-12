import { apiClient } from "./client.js";
import type {
  InternetJobsResponse,
  QueueAddRequest,
  QueueAddResponse,
  QueueCancelResponse,
  QueueMetricsResponse,
  QueueStatusResponse
} from "./contracts.js";

const QUEUE_BASE = "/api/queue";

export function addJobToQueue(payload: QueueAddRequest): Promise<QueueAddResponse> {
  return apiClient.post<QueueAddRequest, QueueAddResponse>(`${QUEUE_BASE}/add`, payload);
}

export function getJobStatus(jobId: string): Promise<QueueStatusResponse> {
  return apiClient.get<QueueStatusResponse>(`${QUEUE_BASE}/status/${encodeURIComponent(jobId)}`);
}

export function cancelJob(jobId: string): Promise<QueueCancelResponse> {
  return apiClient.post<undefined, QueueCancelResponse>(`${QUEUE_BASE}/cancel/${encodeURIComponent(jobId)}`);
}

export function getQueueMetrics(): Promise<QueueMetricsResponse> {
  return apiClient.get<QueueMetricsResponse>(`${QUEUE_BASE}/metrics`);
}

export function getInternetJobs(params?: { query?: string; refresh?: boolean; limit?: number }): Promise<InternetJobsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.query?.trim()) searchParams.set("query", params.query.trim());
  if (params?.refresh) searchParams.set("refresh", "1");
  if (typeof params?.limit === "number") searchParams.set("limit", String(params.limit));
  const query = searchParams.toString();
  const path = query ? `${QUEUE_BASE}/internet-jobs?${query}` : `${QUEUE_BASE}/internet-jobs`;
  return apiClient.get<InternetJobsResponse>(path);
}
