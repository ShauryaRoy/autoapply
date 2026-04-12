import { useCallback, useMemo, useState } from "react";

import { uploadProfileResume } from "../api.js";
import { addJobToQueue } from "../api/queue.js";
import { analyzeJob } from "../api/job.js";
import type { AnalyzeJobResponse } from "../api/contracts.js";

export type OnboardingStep = 1 | 2 | 3;

export interface OnboardingPreferences {
  preferredRoles: string[];
  preferredLocations: Array<"remote" | "hybrid" | "onsite">;
  experienceLevel: "entry" | "mid" | "senior" | "lead" | "";
  salaryExpectation: string;
}

export interface OnboardingResumeState {
  file: File | null;
  fileName: string;
  fileSize: number;
  resumeText: string;
  isUploading: boolean;
  uploadProgress: number;
  error: string | null;
}

export interface OnboardingJobState {
  input: string;
  analysis: AnalyzeJobResponse | null;
  isAnalyzing: boolean;
  isApplying: boolean;
  error: string | null;
}

export interface OnboardingStore {
  step: OnboardingStep;
  resume: OnboardingResumeState;
  preferences: OnboardingPreferences;
  job: OnboardingJobState;
  canGoNext: boolean;
  canGoBack: boolean;
  isComplete: boolean;
  setStep: (step: OnboardingStep) => void;
  goNext: () => void;
  goBack: () => void;
  setPreferredRoles: (roles: string[]) => void;
  setPreferredLocations: (locations: Array<"remote" | "hybrid" | "onsite">) => void;
  setExperienceLevel: (level: OnboardingPreferences["experienceLevel"]) => void;
  setSalaryExpectation: (value: string) => void;
  setJobInput: (value: string) => void;
  uploadResumeFile: (file: File) => Promise<void>;
  analyzeCurrentJob: () => Promise<void>;
  applyFirstJob: () => Promise<void>;
}

const SUCCESS_KEY = "autoapply_onboarding_success_message";

function estimateUploadProgress(start: number): number {
  const elapsed = Date.now() - start;
  const pseudo = Math.floor(20 + elapsed / 20);
  return Math.max(20, Math.min(95, pseudo));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function buildResumeChangePreview(analysis: AnalyzeJobResponse | null): Array<{ before: string; after: string; keywords: string[] }> {
  if (!analysis) return [];
  const missing = analysis.analysis.missing_skills.slice(0, 3);
  const matched = analysis.analysis.matched_skills.slice(0, 3);

  return [
    {
      before: "Built internal tooling for application workflows.",
      after: `Built automation workflow tooling tailored for ${analysis.job.title} outcomes and recruiter velocity.`,
      keywords: matched.length ? matched : ["automation"]
    },
    {
      before: "Collaborated with teams to improve process quality.",
      after: `Collaborated across product and hiring teams to strengthen ${analysis.job.domain} execution quality.`,
      keywords: missing.length ? missing : ["cross-functional"]
    }
  ];
}

function buildAnswerPreview(analysis: AnalyzeJobResponse | null): Partial<Record<"summary" | "why_role" | "strengths" | "experience", string>> {
  if (!analysis) return {};

  return {
    summary: analysis.job.tldr,
    why_role: `This role aligns with my strengths in ${analysis.analysis.matched_skills.slice(0, 3).join(", ") || "product execution"}.`,
    strengths: `Top fit skills: ${analysis.analysis.matched_skills.slice(0, 5).join(", ") || "adaptability"}.`,
    experience: `I have practical experience applying ${analysis.job.domain} patterns in production teams.`
  };
}

export function useOnboardingStore(): OnboardingStore {
  const [step, setStep] = useState<OnboardingStep>(1);
  const [isComplete, setIsComplete] = useState(false);
  const [resume, setResume] = useState<OnboardingResumeState>({
    file: null,
    fileName: "",
    fileSize: 0,
    resumeText: "",
    isUploading: false,
    uploadProgress: 0,
    error: null
  });
  const [preferences, setPreferences] = useState<OnboardingPreferences>({
    preferredRoles: [],
    preferredLocations: [],
    experienceLevel: "",
    salaryExpectation: ""
  });
  const [job, setJob] = useState<OnboardingJobState>({
    input: "",
    analysis: null,
    isAnalyzing: false,
    isApplying: false,
    error: null
  });

  const canGoNext = useMemo(() => {
    if (step === 1) return Boolean(resume.resumeText.trim());
    if (step === 2) return Boolean(preferences.preferredRoles.length) && Boolean(preferences.experienceLevel);
    return false;
  }, [preferences.experienceLevel, preferences.preferredRoles.length, resume.resumeText, step]);

  const canGoBack = step > 1 && !isComplete;

  const goNext = useCallback(() => {
    setStep((current) => (current < 3 ? ((current + 1) as OnboardingStep) : current));
  }, []);

  const goBack = useCallback(() => {
    setStep((current) => (current > 1 ? ((current - 1) as OnboardingStep) : current));
  }, []);

  const setPreferredRoles = useCallback((roles: string[]) => {
    setPreferences((current) => ({ ...current, preferredRoles: roles }));
  }, []);

  const setPreferredLocations = useCallback((locations: Array<"remote" | "hybrid" | "onsite">) => {
    setPreferences((current) => ({ ...current, preferredLocations: locations }));
  }, []);

  const setExperienceLevel = useCallback((level: OnboardingPreferences["experienceLevel"]) => {
    setPreferences((current) => ({ ...current, experienceLevel: level }));
  }, []);

  const setSalaryExpectation = useCallback((value: string) => {
    setPreferences((current) => ({ ...current, salaryExpectation: value }));
  }, []);

  const setJobInput = useCallback((value: string) => {
    setJob((current) => ({ ...current, input: value }));
  }, []);

  const uploadResumeFile = useCallback(async (file: File) => {
    if (!file) return;

    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "pdf" && extension !== "docx") {
      setResume((current) => ({
        ...current,
        error: "Please upload a PDF or DOCX file."
      }));
      return;
    }

    const startedAt = Date.now();
    setResume({
      file,
      fileName: file.name,
      fileSize: file.size,
      resumeText: "",
      isUploading: true,
      uploadProgress: 8,
      error: null
    });

    const progressTimer = window.setInterval(() => {
      setResume((current) => {
        if (!current.isUploading) return current;
        return {
          ...current,
          uploadProgress: estimateUploadProgress(startedAt)
        };
      });
    }, 120);

    try {
      const response = await uploadProfileResume({ file });
      window.clearInterval(progressTimer);

      setResume((current) => ({
        ...current,
        resumeText: response.resumeText,
        isUploading: false,
        uploadProgress: 100,
        error: null
      }));
    } catch (error) {
      window.clearInterval(progressTimer);
      setResume((current) => ({
        ...current,
        isUploading: false,
        uploadProgress: 0,
        error: error instanceof Error ? error.message : "Resume upload failed. Please try again."
      }));
    }
  }, []);

  const analyzeCurrentJob = useCallback(async () => {
    const input = job.input.trim();
    if (!input) {
      setJob((current) => ({ ...current, error: "Paste a job URL or description first." }));
      return;
    }

    setJob((current) => ({ ...current, isAnalyzing: true, error: null }));
    try {
      const analysis = await analyzeJob({
        jobDescription: input,
        profileText: resume.resumeText,
        profileSkills: preferences.preferredRoles,
        preferredRemotePolicies: preferences.preferredLocations.length
          ? preferences.preferredLocations.map((value) =>
              value === "remote" ? "fully-remote" : value === "hybrid" ? "hybrid" : "onsite"
            )
          : undefined
      });

      setJob((current) => ({ ...current, analysis, isAnalyzing: false, error: null }));
    } catch (error) {
      setJob((current) => ({
        ...current,
        isAnalyzing: false,
        error: error instanceof Error ? error.message : "Job analysis failed."
      }));
    }
  }, [job.input, preferences.preferredLocations, preferences.preferredRoles, resume.resumeText]);

  const applyFirstJob = useCallback(async () => {
    if (!job.analysis) {
      setJob((current) => ({ ...current, error: "Analyze a job before applying." }));
      return;
    }

    setJob((current) => ({ ...current, isApplying: true, error: null }));
    const generatedJobId = `job_${Date.now()}`;

    const looksLikeUrl = /^https?:\/\//i.test(job.input.trim());
    const jobUrl = looksLikeUrl ? job.input.trim() : `https://autoapply.local/job/${encodeURIComponent(generatedJobId)}`;

    try {
      await addJobToQueue({
        job_id: generatedJobId,
        job_url: jobUrl,
        user_profile: {
          preferredRoles: preferences.preferredRoles,
          preferredLocations: preferences.preferredLocations,
          experienceLevel: preferences.experienceLevel,
          salaryExpectation: preferences.salaryExpectation
        },
        resume: {
          text: resume.resumeText,
          fileName: resume.fileName,
          fileSize: formatBytes(resume.fileSize)
        }
      });

      localStorage.setItem(SUCCESS_KEY, "Your first application is in progress 🚀");
      setJob((current) => ({ ...current, isApplying: false }));
      setIsComplete(true);
      window.history.pushState({}, "", "/dashboard");
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (error) {
      setJob((current) => ({
        ...current,
        isApplying: false,
        error: error instanceof Error ? error.message : "Unable to queue your first application."
      }));
    }
  }, [job.analysis, job.input, preferences, resume.fileName, resume.fileSize, resume.resumeText]);

  return {
    step,
    resume,
    preferences,
    job,
    canGoNext,
    canGoBack,
    isComplete,
    setStep,
    goNext,
    goBack,
    setPreferredRoles,
    setPreferredLocations,
    setExperienceLevel,
    setSalaryExpectation,
    setJobInput,
    uploadResumeFile,
    analyzeCurrentJob,
    applyFirstJob
  };
}

export function getOnboardingPreview(store: Pick<OnboardingStore, "job">): {
  resumeChanges: Array<{ before: string; after: string; keywords: string[] }>;
  answers: Partial<Record<"summary" | "why_role" | "strengths" | "experience", string>>;
} {
  return {
    resumeChanges: buildResumeChangePreview(store.job.analysis),
    answers: buildAnswerPreview(store.job.analysis)
  };
}
