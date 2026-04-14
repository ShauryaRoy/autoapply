import { type JobProfile } from "../tailor/types.js";
import { type UserProfileForScoring } from "./types.js";

function normalizeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

export function skillMatch(jobProfile: JobProfile, userProfile: UserProfileForScoring): { value: number; matched: number; total: number } {
  const requiredSkills = jobProfile.skills.map((skill) => skill.toLowerCase());
  const userSkills = new Set(userProfile.skills.map((skill) => skill.toLowerCase()));
  const matched = requiredSkills.filter((skill) => userSkills.has(skill)).length;
  const total = requiredSkills.length;
  const value = total > 0 ? matched / total : 0;
  return { value, matched, total };
}

export function seniorityMatch(jobProfile: JobProfile, userProfile: UserProfileForScoring): { value: number; matched: boolean } {
  const userPreference = userProfile.seniorityPreference;
  if (!userPreference) {
    if (typeof userProfile.yearsExperience !== "number") {
      return { value: 0.6, matched: true };
    }

    const mapped: JobProfile["seniority"] =
      userProfile.yearsExperience < 1 ? "intern" :
      userProfile.yearsExperience < 3 ? "junior" :
      userProfile.yearsExperience < 6 ? "mid" : "senior";

    const matched = mapped === jobProfile.seniority;
    return { value: matched ? 1 : 0.3, matched };
  }

  const matched = userPreference === jobProfile.seniority;
  return { value: matched ? 1 : 0.3, matched };
}

export function keywordOverlap(jobProfile: JobProfile, userProfile: UserProfileForScoring): { value: number; overlap: number; total: number } {
  const userText = `${userProfile.skills.join(" ")} ${userProfile.resumeText ?? ""}`;
  const userTokens = new Set(normalizeTokens(userText));
  const keywords = jobProfile.keywords.map((keyword) => keyword.toLowerCase());
  const overlap = keywords.filter((keyword) => normalizeTokens(keyword).some((token) => userTokens.has(token))).length;
  const total = keywords.length;
  const value = total > 0 ? overlap / total : 0;
  return { value, overlap, total };
}

export function coverageCheck(jobProfile: JobProfile, userProfile: UserProfileForScoring, jobDescription: string): { value: number; covered: number; total: number } {
  const requiredAreas = [
    ...jobProfile.skills,
    ...jobProfile.keywords.slice(0, 5)
  ];

  const userContext = `${userProfile.skills.join(" ")} ${userProfile.resumeText ?? ""} ${jobDescription}`.toLowerCase();
  const covered = requiredAreas.filter((area) => userContext.includes(area.toLowerCase())).length;
  const total = requiredAreas.length;
  const value = total > 0 ? covered / total : 0;
  return { value, covered, total };
}
