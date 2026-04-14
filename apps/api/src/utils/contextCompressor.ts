/**
 * contextCompressor.ts
 *
 * Compresses the prompt context before LLM generation.
 *
 * Problem being solved:
 *   The v1 service sent the raw job description (up to 3000 chars) and
 *   the full serialised profile to every LLM call. This causes:
 *     - Unnecessary token spend (big JD + all experience bullets)
 *     - Model attention dilution (irrelevant profile facts crowd out signal)
 *     - Inconsistent answers when context overflows the attention window
 *
 * Solution:
 *   1. JD Compression  — extract only the actionable signals (responsibilities,
 *      requirements, key phrases) into a ≤500-word summary.
 *   2. Profile Compression — filter profile facts that overlap with the JD.
 *      Only include experience bullets / skills that are relevant to the role.
 *   3. Return a structured CompressedContext object used to build prompts.
 *
 * This is purely deterministic (no LLM call here). It runs before the
 * generation call, not during it.
 */

import type { QuestionCategory } from "./questionHasher.js";


// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface ProfileFact {
  type: "skill" | "experience_bullet" | "education" | "link" | "project";
  text: string;
  /** How many JD terms this fact matches (higher = more relevant) */
  relevanceScore: number;
}

export interface CompressedContext {
  /** Company name */
  company: string;
  /** Job title */
  role: string;
  /**
   * Key JD signals extracted deterministically:
   *  - responsibilities (action-verb sentences)
   *  - requirements (must/required/experience lines)
   *  - headline keywords (nouns/skills mentioned ≥2 times)
   */
  jdSummary: string;
  /** Top-N profile facts sorted by JD relevance */
  relevantProfileFacts: ProfileFact[];
  /** Skills confirmed present in both JD and profile */
  confirmedSkills: string[];
  /** Skills in JD but absent from profile (DO NOT CLAIM) */
  missingSkills: string[];
  /** Archetype detected by job intelligence layer */
  archetype?: string;
  /** Overall match score 0-100 */
  matchScore?: number;
  /** Token budget remaining estimate (rough chars) */
  estimatedContextChars: number;
}

// ─────────────────────────────────────────────────────────────
// JD Compression
// ─────────────────────────────────────────────────────────────

const REQUIREMENT_SIGNALS = /\b(require[sd]?|must have|essential|you (have|bring|will|are)|mandatory|minimum)\b/i;
const RESPONSIBILITY_SIGNALS = /\b(responsibl|will (build|lead|own|design|drive|ship|work)|you will|your role)\b/i;
const ACTION_VERB_LINE = /^[-•\*]?\s*(build|lead|design|drive|own|ship|manage|develop|run|create|launch|deliver|improve|scale|architect|collaborate|analyze|evaluate|define)/i;

/**
 * Extract the highest-signal sentences from a job description.
 * Returns a compact string ≤600 words.
 */
export function compressJobDescription(rawJd: string): string {
  if (!rawJd || rawJd.trim().length < 50) return rawJd || "(No job description provided)";

  const lines = rawJd
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 10 && l.length < 300);

  const requirements: string[] = [];
  const responsibilities: string[] = [];
  const other: string[] = [];

  for (const line of lines) {
    if (REQUIREMENT_SIGNALS.test(line)) {
      requirements.push(line);
    } else if (RESPONSIBILITY_SIGNALS.test(line) || ACTION_VERB_LINE.test(line)) {
      responsibilities.push(line);
    } else {
      other.push(line);
    }
  }

  // Take top items from each bucket to stay within ~600 word budget
  const selected = [
    ...responsibilities.slice(0, 8),
    ...requirements.slice(0, 8),
    ...other.slice(0, 4),
  ];

  // Deduplicate
  const seen = new Set<string>();
  const deduped = selected.filter((l) => {
    const key = l.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const joined = deduped.join("\n");

  // Hard cap at 600 words
  const words = joined.split(/\s+/);
  return words.slice(0, 600).join(" ");
}

// ─────────────────────────────────────────────────────────────
// Profile Compression
// ─────────────────────────────────────────────────────────────

/**
 * Score a profile fact string against a JD.
 * Returns how many unique JD terms the fact contains.
 */
function scoreFactRelevance(fact: string, jdTerms: Set<string>): number {
  const lower = fact.toLowerCase();
  let score = 0;
  for (const term of jdTerms) {
    if (lower.includes(term)) score++;
  }
  return score;
}

/**
 * Extract all meaningful tokens from a JD for relevance scoring.
 * Filters out stop words and short tokens.
 */
function extractJdTerms(jdText: string): Set<string> {
  const STOP = new Set([
    "the", "a", "an", "and", "or", "in", "of", "to", "for", "with", "on",
    "at", "by", "from", "as", "is", "be", "this", "that", "will", "you",
    "your", "we", "our", "have", "has", "are", "not", "but", "can",
  ]);

  return new Set(
    jdText
      .toLowerCase()
      .replace(/[^a-z0-9\s\-\.]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3 && !STOP.has(t))
  );
}

export interface ProfileSnapshot {
  personal: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    location?: string;
  };
  experience: Array<{
    job_title: string | null;
    company: string | null;
    description: string | null;
    start_year: number | null;
    end_year: number | null;
    current: boolean;
  }>;
  education: Array<{
    institution: string | null;
    degree: string | null;
    field_of_study: string | null;
  }>;
  skills: string[];
  links: {
    linkedin?: string | null;
    github?: string | null;
    portfolio?: string | null;
  };
  projects: Array<{
    name: string | null;
    description: string | null;
  }>;
}

/**
 * Extract profile facts relevant to the given JD.
 * Returns facts sorted by relevance score (highest first), capped at maxFacts.
 */
export function extractRelevantProfileFacts(
  profile: ProfileSnapshot,
  jdText: string,
  maxFacts = 10
): ProfileFact[] {
  const jdTerms = extractJdTerms(jdText);
  const facts: ProfileFact[] = [];

  // Skills
  for (const skill of profile.skills) {
    facts.push({
      type: "skill",
      text: skill,
      relevanceScore: scoreFactRelevance(skill, jdTerms),
    });
  }

  // Experience bullets
  for (const exp of profile.experience) {
    if (exp.description) {
      const sentences = exp.description
        .split(/[.!?\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 15);

      for (const sentence of sentences) {
        facts.push({
          type: "experience_bullet",
          text: `${sentence} (${exp.job_title ?? "role"} at ${exp.company ?? "company"})`,
          relevanceScore: scoreFactRelevance(sentence, jdTerms),
        });
      }
    } else if (exp.job_title && exp.company) {
      facts.push({
        type: "experience_bullet",
        text: `${exp.job_title} at ${exp.company}`,
        relevanceScore: scoreFactRelevance(`${exp.job_title} ${exp.company}`, jdTerms),
      });
    }
  }

  // Education
  for (const edu of profile.education) {
    if (edu.degree || edu.institution) {
      const text = `${edu.degree ?? ""} ${edu.field_of_study ? `in ${edu.field_of_study}` : ""} from ${edu.institution ?? ""}`.trim();
      facts.push({
        type: "education",
        text,
        relevanceScore: scoreFactRelevance(text, jdTerms),
      });
    }
  }

  // Projects
  for (const proj of profile.projects) {
    if (proj.name || proj.description) {
      const text = `${proj.name ?? "Project"}: ${proj.description ?? ""}`.trim();
      facts.push({
        type: "project",
        text,
        relevanceScore: scoreFactRelevance(text, jdTerms),
      });
    }
  }

  // Links (always include if present)
  if (profile.links.linkedin) {
    facts.push({ type: "link", text: `LinkedIn: ${profile.links.linkedin}`, relevanceScore: 1 });
  }
  if (profile.links.github) {
    facts.push({ type: "link", text: `GitHub: ${profile.links.github}`, relevanceScore: 1 });
  }
  if (profile.links.portfolio) {
    facts.push({ type: "link", text: `Portfolio: ${profile.links.portfolio}`, relevanceScore: 1 });
  }

  // Deterministic Selection Rule:
  // - Top 2 experience bullets (if score > 0 or if only ones available)
  // - Top 1 project (if available)
  // - Top 5 skills
  // - Then fill the rest with whatever is highest scored

  const sortedSkills = facts.filter(f => f.type === "skill").sort((a, b) => b.relevanceScore - a.relevanceScore);
  const sortedExp = facts.filter(f => f.type === "experience_bullet").sort((a, b) => b.relevanceScore - a.relevanceScore);
  const sortedProj = facts.filter(f => f.type === "project").sort((a, b) => b.relevanceScore - a.relevanceScore);
  const otherFacts = facts.filter(f => f.type !== "skill" && f.type !== "experience_bullet" && f.type !== "project");

  const selected = new Set<ProfileFact>();
  
  // Mandatory deterministic inclusions
  sortedExp.slice(0, 2).forEach(f => selected.add(f));
  sortedProj.slice(0, 1).forEach(f => selected.add(f));
  sortedSkills.slice(0, 5).forEach(f => selected.add(f));
  
  // Fill remaining slots
  const remaining = facts
    .filter(f => !selected.has(f))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

  for (const f of remaining) {
    if (selected.size >= maxFacts) break;
    selected.add(f);
  }

  return Array.from(selected);
}

// ─────────────────────────────────────────────────────────────
// Main Compressor
// ─────────────────────────────────────────────────────────────

export function buildCompressedContext(params: {
  company: string;
  role: string;
  jobDescriptionText: string;
  profile: ProfileSnapshot;
  jobAnalysis?: {
    matchedSkills: string[];
    missingSkills: string[];
    archetype?: string;
    score?: number;
  };
}): CompressedContext {
  const { company, role, jobDescriptionText, profile, jobAnalysis } = params;

  const jdSummary = compressJobDescription(jobDescriptionText);

  const relevantProfileFacts = extractRelevantProfileFacts(
    profile,
    jobDescriptionText,
    12 // top 12 relevant facts
  );

  const confirmedSkills = jobAnalysis?.matchedSkills ?? [];
  const missingSkills = jobAnalysis?.missingSkills ?? [];

  // Rough character estimate for budget tracking
  const contextChars =
    jdSummary.length +
    relevantProfileFacts.map((f) => f.text).join(" ").length +
    confirmedSkills.join(" ").length;

  return {
    company,
    role,
    jdSummary,
    relevantProfileFacts,
    confirmedSkills,
    missingSkills,
    archetype: jobAnalysis?.archetype,
    matchScore: jobAnalysis?.score,
    estimatedContextChars: contextChars,
  };
}

// ─────────────────────────────────────────────────────────────
// Context → Prompt Block Formatter
// ─────────────────────────────────────────────────────────────

/**
 * Format a CompressedContext into a prompt-ready string block.
 * Keeps skills, experience bullets, and education separate for
 * clear LLM attribution.
 */
export function formatCompressedContextForPrompt(
  ctx: CompressedContext,
  profile: ProfileSnapshot
): string {
  const skillFacts = ctx.relevantProfileFacts.filter((f) => f.type === "skill");
  const expFacts = ctx.relevantProfileFacts.filter((f) => f.type === "experience_bullet");
  const eduFacts = ctx.relevantProfileFacts.filter((f) => f.type === "education");
  const projFacts = ctx.relevantProfileFacts.filter((f) => f.type === "project");
  const linkFacts = ctx.relevantProfileFacts.filter((f) => f.type === "link");

  const lines: string[] = [];

  lines.push(`## Target Application`);
  lines.push(`Company: ${ctx.company}`);
  lines.push(`Role: ${ctx.role}`);
  if (ctx.archetype) lines.push(`Archetype: ${ctx.archetype}`);
  if (ctx.matchScore !== undefined) lines.push(`Match Score: ${ctx.matchScore}/100`);

  lines.push(`\n## Key Job Requirements (extracted)`);
  lines.push(ctx.jdSummary);

  lines.push(`\n## Candidate: ${profile.personal.firstName} ${profile.personal.lastName}`);
  if (profile.personal.location) lines.push(`Location: ${profile.personal.location}`);

  if (skillFacts.length > 0) {
    lines.push(`\n## Relevant Skills (matched to JD)`);
    lines.push(skillFacts.map((f) => f.text).join(", "));
  }

  if (expFacts.length > 0) {
    lines.push(`\n## Relevant Experience (highest JD overlap first)`);
    expFacts.slice(0, 6).forEach((f) => lines.push(`• ${f.text}`));
  }

  if (projFacts.length > 0) {
    lines.push(`\n## Projects & Achievements`);
    projFacts.forEach((f) => lines.push(`• ${f.text}`));
  }

  if (eduFacts.length > 0) {
    lines.push(`\n## Education`);
    eduFacts.forEach((f) => lines.push(`• ${f.text}`));
  }

  if (linkFacts.length > 0) {
    lines.push(`\n## Links`);
    linkFacts.forEach((f) => lines.push(f.text));
  }

  lines.push(`\n## Intelligence Layer`);
  lines.push(`Confirmed Skills (in profile): ${ctx.confirmedSkills.join(", ") || "none detected"}`);
  lines.push(`Missing Skills (DO NOT claim these): ${ctx.missingSkills.join(", ") || "none"}`);

  return lines.join("\n");
}
