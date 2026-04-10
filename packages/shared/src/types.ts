import { z } from "zod";

export type ATSProvider = "workday" | "greenhouse" | "lever" | "smartrecruiters" | "unknown";

export const CreateApplicationSchema = z.object({
  jobUrl: z.string().url(),
  targetRole: z.string().min(1),
  preferredResumeId: z.string().optional(),
  metadata: z.record(z.any()).optional()
});

export type CreateApplicationInput = z.infer<typeof CreateApplicationSchema>;

export type ApplicationStep =
  | "queued"
  | "job_scraped"
  | "job_analyzed"
  | "resume_optimized"
  | "answers_generated"
  | "browser_started"
  | "logged_in"
  | "form_filled"
  | "submitted"
  | "completed"
  | "failed"
  | "paused";

export interface ApplicationState {
  applicationId: string;
  userId: string;
  step: ApplicationStep;
  atsProvider: ATSProvider;
  retries: number;
  maxRetries: number;
  lastError?: string;
  checkpoint?: Record<string, unknown>;
}

export interface StepEvent {
  applicationId: string;
  step: ApplicationStep;
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface ResumeOptimizationOutput {
  resumeMarkdown: string;
  matchingProjects: string[];
  extractedKeywords: string[];
}
