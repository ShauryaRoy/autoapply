export type JobProfile = {
  role: string;
  skills: string[];
  keywords: string[];
  seniority: "intern" | "junior" | "mid" | "senior";
};

export type ResumeSectionEntry = {
  title: string;
  bullets: string[];
};

export type ResumeCanonical = {
  summary: string;
  skills: string[];
  experience: ResumeSectionEntry[];
  projects: ResumeSectionEntry[];
  activities: ResumeSectionEntry[];
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
  originalResume: string;
  jobDescription: string;
  requiredSkills: string[];
  preferredSkills: string[];
};

export type TailoredResume = ResumeCanonical;

export type EnhanceAnswersInput = {
  questions: string[];
  baseAnswers: Record<string, string>;
  jobProfile: JobProfile;
};
