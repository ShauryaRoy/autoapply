import { type JobScore, type ScoreJobInput } from "./types.js";
import { coverageCheck, keywordOverlap, seniorityMatch, skillMatch } from "./scoringRules.js";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreJob(input: ScoreJobInput): JobScore {
  const skill = skillMatch(input.jobProfile, input.userProfile);
  const seniority = seniorityMatch(input.jobProfile, input.userProfile);
  const keyword = keywordOverlap(input.jobProfile, input.userProfile);
  const coverage = coverageCheck(input.jobProfile, input.userProfile, input.jobDescription);

  const score = clamp01(
    skill.value * 0.4 +
    seniority.value * 0.2 +
    keyword.value * 0.2 +
    coverage.value * 0.2
  );

  const reasons: string[] = [];

  if (skill.value >= 0.7) reasons.push("High skill match");
  else if (skill.value <= 0.35) reasons.push("Low skill match");

  if (seniority.matched) reasons.push("Seniority aligned");
  else reasons.push("Seniority mismatch");

  if (keyword.value >= 0.5) reasons.push("Good keyword overlap");
  else reasons.push("Low keyword overlap");

  if (coverage.value >= 0.5) reasons.push("Strong resume coverage");
  else reasons.push("Limited resume coverage");

  const decision =
    score >= 0.75 ? "auto_apply" :
    score >= 0.5 ? "review" : "skip";

  return {
    score,
    decision,
    reasons
  };
}
