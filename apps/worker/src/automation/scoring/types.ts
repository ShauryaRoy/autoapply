import { type JobProfile } from "../tailor/types.js";

export type JobScoreDecision = "auto_apply" | "review" | "skip";

export type JobScore = {
  score: number;
  decision: JobScoreDecision;
  reasons: string[];
};

export type UserProfileForScoring = {
  skills: string[];
  yearsExperience?: number;
  seniorityPreference?: JobProfile["seniority"];
  resumeText?: string;
};

export type ScoreJobInput = {
  jobProfile: JobProfile;
  userProfile: UserProfileForScoring;
  jobDescription: string;
};
