import { apiClient } from "./client.js";

export interface CreateApplicationRequest {
  jobUrl: string;
  targetRole: string;
  metadata?: Record<string, unknown>;
}

export interface CreateApplicationResponse {
  applicationId: string;
}

export interface ApplicationEvent {
  id: string;
  step: string;
  message: string;
  createdAt: string;
  payloadJson?: Record<string, unknown>;
}

export interface ApplicationDetails {
  id: string;
  currentStep: string;
  status: string;
  jobUrl: string;
  targetRole: string;
  events: ApplicationEvent[];
}

const APPLICATION_BASE = "/api/applications";

export function createApplication(payload: CreateApplicationRequest): Promise<CreateApplicationResponse> {
  return apiClient.post<CreateApplicationRequest, CreateApplicationResponse>(APPLICATION_BASE, payload);
}

export function getApplication(applicationId: string): Promise<ApplicationDetails> {
  return apiClient.get<ApplicationDetails>(`${APPLICATION_BASE}/${encodeURIComponent(applicationId)}`);
}

export function pauseApplication(applicationId: string): Promise<void> {
  return apiClient.post<undefined, void>(`${APPLICATION_BASE}/${encodeURIComponent(applicationId)}/pause`);
}

export function resumeApplication(applicationId: string): Promise<void> {
  return apiClient.post<undefined, void>(`${APPLICATION_BASE}/${encodeURIComponent(applicationId)}/resume`);
}
