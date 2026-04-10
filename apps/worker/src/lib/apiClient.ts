import axios from "axios";
import type { InternalAxiosRequestConfig } from "axios";

const api = axios.create();

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  config.baseURL = process.env.API_BASE_URL ?? "http://localhost:4000";
  config.headers["x-worker-token"] = process.env.WORKER_TOKEN ?? "";
  return config;
});

export async function workerLogEvent(input: {
  applicationId: string;
  step: string;
  message: string;
  payloadJson?: Record<string, unknown>;
}): Promise<void> {
  await api.post("/api/internal/worker/event", input);
}

export async function workerUpdateStep(input: {
  applicationId: string;
  currentStep: string;
  status?: string;
  checkpointJson?: Record<string, unknown>;
}): Promise<void> {
  await api.post("/api/internal/worker/step", input);
}

export async function workerAdvanceStep(input: { applicationId: string; nextStep: string }): Promise<void> {
  await api.post("/api/internal/worker/advance", input);
}

export async function workerWriteDlq(input: {
  queueName: string;
  originalJobId: string;
  applicationId?: string;
  userId?: string;
  step?: string;
  reason: string;
  payloadJson: Record<string, unknown>;
}): Promise<void> {
  await api.post("/api/internal/worker/dlq", input);
}
