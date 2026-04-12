import type { Decision, ResumeDiffLine } from "./types.js";

export const ORDERED_PIPELINE = [
  "queued",
  "job_scraped",
  "job_analyzed",
  "resume_optimized",
  "answers_generated",
  "form_filled",
  "submitted"
] as const;

export const ROLE_SUGGESTIONS = [
  "Senior Frontend Engineer",
  "Full Stack Engineer",
  "React Engineer",
  "Product Engineer",
  "AI Engineer"
];

export function inferDecision(score: number): Decision {
  if (score >= 80) return "APPLY";
  if (score >= 60) return "RISKY";
  return "SKIP";
}

export function deriveMatchScore(targetRole: string, matchedSkillsCount: number): number {
  if (!targetRole.trim()) return 68;
  const base = 62;
  const bonus = Math.min(30, matchedSkillsCount * 5);
  return Math.min(97, base + bonus);
}

export function getResumeDiff(profileSkills: string[]): ResumeDiffLine[] {
  const sanitizedSkills = profileSkills.map((skill) => skill.trim()).filter(Boolean).slice(0, 4);
  const keywords = sanitizedSkills.length ? sanitizedSkills : ["React", "TypeScript", "Automation"];

  return [
    {
      before: "Built internal tools for job application workflows.",
      after: `Built ${keywords[0]}-driven automation tools that reduced manual application time by 65%.`,
      injectedKeywords: [keywords[0]]
    },
    {
      before: "Collaborated with hiring teams and recruiters.",
      after: `Partnered cross-functionally with recruiting and product teams to optimize ${keywords[1]} hiring funnels.`,
      injectedKeywords: [keywords[1]]
    },
    {
      before: "Improved candidate tracking process.",
      after: `Implemented ${keywords[2]} instrumentation for ATS analytics, improving funnel visibility and conversion quality.`,
      injectedKeywords: [keywords[2]]
    }
  ];
}
