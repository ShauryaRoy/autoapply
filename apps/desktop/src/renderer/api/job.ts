import { apiClient } from "./client.js";
import type { AnalyzeJobRequest, AnalyzeJobResponse, JobAnalysisDetailsResponse } from "./contracts.js";

const JOB_BASE = "/api/job";

// This endpoint is reserved for direct job-level details retrieval and is polling-safe.
export function getJobAnalysisDetails(jobId: string): Promise<JobAnalysisDetailsResponse> {
  return apiClient.get<JobAnalysisDetailsResponse>(`${JOB_BASE}/${encodeURIComponent(jobId)}`);
}

export const getJobDetails = getJobAnalysisDetails;

export function analyzeJob(payload: AnalyzeJobRequest): Promise<AnalyzeJobResponse> {
  return apiClient.post<AnalyzeJobRequest, AnalyzeJobResponse>(`${JOB_BASE}/analyze`, payload);
}
