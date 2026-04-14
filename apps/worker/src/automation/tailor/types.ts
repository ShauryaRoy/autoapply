export type JobProfile = {
  role: string;
  skills: string[];
  keywords: string[];
  seniority: "intern" | "junior" | "mid" | "senior";
};

export type ResumeCanonical = {
  summary: string;
  skills: string[];
  experience: Array<{
    title: string;
    bullets: string[];
  }>;
  rawText: string;
  keywordsInjected: string[];
  version?: number;
  generatedFor?: string;
  generatedAt?: string;
};

export type AnalyzeJobInput = {
  jobDescription: string;
};

export type TailorResumeInput = {
  baseResume: string;
  jobProfile: JobProfile;
};

export type EnhanceAnswersInput = {
  questions: string[];
  baseAnswers: Record<string, string>;
  jobProfile: JobProfile;
};
