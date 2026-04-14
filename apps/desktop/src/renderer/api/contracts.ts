import type { JobStatus } from "./status.js";

export interface QueueAddRequest {
  job_id: string;
  job_url: string;
  user_profile: Record<string, unknown>;
  resume: Record<string, unknown>;
  resume_path?: string;
}

export interface QueueAddResponse {
  job_id: string;
  bullmq_id: string;
  status: "QUEUED";
}

export interface QueueSteps {
  analyze?: unknown;
  patched_resume?: unknown;
  answers?: unknown;
  apply?: unknown;
}

export interface QueueStatusResponse {
  status: JobStatus | "PAUSED" | "COMPLETED" | "QUEUED";
  progress: number;
  steps: QueueSteps;
  logs: unknown[];
  errors: string[];
  result: Record<string, unknown>;
}

export interface QueueCancelResponse {
  status: "CANCELLED";
}

export interface QueueMetricsResponse {
  total_jobs: number;
  success_rate: string;
  avg_execution_time_ms: number;
  failure_reasons: Record<string, number>;
}

export interface InternetJobItem {
  id: string;
  title: string;
  url: string;
  company: string;
  location: string;
  source: string;
  fetchedAt: string;
}

export interface InternetJobsResponse {
  jobs: InternetJobItem[];
  totalScannedCompanies: number;
  totalFetchedJobs: number;
  fromCache: boolean;
  errors: Array<{ company: string; message: string }>;
}

export interface JobAnalysisDetailsResponse {
  job_id: string;
  status: JobStatus | "PAUSED" | "COMPLETED" | "QUEUED";
  summary?: string;
  details?: Record<string, unknown>;
}

export interface AnalyzeJobRequest {
  jobDescription: string;
  companyName?: string;
  jobTitle?: string;
  profileText?: string;
  profileSkills?: string[];
  ghostRiskHints?: {
    postingAgeDays?: number | null;
    hasApplyButton?: boolean;
    repostCount?: number;
  };
  preferredRemotePolicies?: Array<"fully-remote" | "hybrid" | "onsite" | "geo-restricted" | "unknown">;
}

export interface AnalyzeJobResponse {
  job: {
    title: string;
    company: string;
    remotePolicy: string;
    archetype: string;
    seniority: string;
    domain: string;
    tldr: string;
  };
  analysis: {
    score: number;
    confidence?: "LOW" | "MEDIUM" | "HIGH";
    decision: "APPLY" | "RISKY" | "SKIP";
    apply_priority: "HIGH" | "MEDIUM" | "LOW";
    matched_skills: string[];
    missing_skills: string[];
    risk_flags: string[];
    match_score: number;
    score_breakdown: Record<string, number>;
    score_breakdown_verbose?: {
      skill_match: { value: number; impact: "LOW" | "MEDIUM" | "HIGH" };
      keyword_overlap: { value: number; impact: "LOW" | "MEDIUM" | "HIGH" };
      experience_match: { value: number; impact: "LOW" | "MEDIUM" | "HIGH" };
      risk_score: { value: number; impact: "NEGATIVE" };
    };
    reasons?: {
      missing_skills: string[];
      experience_gap: string | null;
      keyword_mismatch: string[];
      risk_summary: Array<{ type: string; message: string }>;
      risk_summary_text?: string[];
    };
  };
  details: {
    roleSummary: Record<string, unknown>;
    requiredSkills: string[];
    preferredSkills: string[];
    keywords: string[];
    cvMatch: Record<string, unknown>;
    ghostRisk: Record<string, unknown>;
  };
}
