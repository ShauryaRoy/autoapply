/**
 * answerValidator.ts
 *
 * Answer quality validation for the Live Apply pipeline.
 *
 * Problem being solved:
 *   The v1 service had no answer-level validation post-generation.
 *   Generic phrasing, missing specifics, overlength answers, tone
 *   violations, and unsupported claims could all reach the UI unchecked.
 *
 * Solution:
 *   A composable validation pipeline with per-check granularity:
 *     1. Generic phrase detection (Career-Ops NEVER list)
 *     2. Specificity check (answer must reference something concrete)
 *     3. Length check (free_text ≤ 100 words, others ≤ 30 words)
 *     4. Tone check (no emotional/passive vocabulary)
 *     5. Unsupported claim detection (invented metrics not in profile)
 *     6. Empty/near-empty detection
 *
 *   Each check produces a ValidationFlag rather than a hard reject.
 *   Flags are surfaced in the UI as reviewNotes instead of blocking
 *   generation — the human reviewer decides whether to edit or accept.
 *
 *   Hard failures (schema errors, completely empty answers) ARE blocking.
 */

import type { QuestionCategory } from "./questionHasher.js";


// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type FlagSeverity = "error" | "warning" | "info";

export interface ValidationFlag {
  code: string;
  severity: FlagSeverity;
  message: string;
  isHardFail?: boolean;
}

export interface AnswerValidationResult {
  /** True if the answer passes all error-level checks (may still have warnings) */
  valid: boolean;
  /** All flags found (errors + warnings) */
  flags: ValidationFlag[];
  /** Single-line review note for UI display, or null if clean */
  reviewNote: string | null;
}

// ─────────────────────────────────────────────────────────────
// Word limits per question category
// ─────────────────────────────────────────────────────────────

const WORD_LIMITS: Record<QuestionCategory, number> = {
  free_text: 100,
  yes_no: 10,
  dropdown: 10,
  salary: 20,
  upload: 10,
  unknown: 60,
};

// ─────────────────────────────────────────────────────────────
// Check 1: Generic phrase detection
// Source: Career-Ops _shared.md + auto-pipeline.md §NEVER list
// ─────────────────────────────────────────────────────────────

const GENERIC_PHRASES: Array<{ phrase: string; suggestion: string }> = [
  { phrase: "i am passionate about", suggestion: "Show a concrete proof point instead" },
  { phrase: "i'm passionate about", suggestion: "Show a concrete proof point instead" },
  { phrase: "i have always been fascinated", suggestion: "State what you built/delivered instead" },
  { phrase: "results-oriented", suggestion: "Remove — use specific metric or outcome" },
  { phrase: "proven track record", suggestion: "Remove — cite the actual track record" },
  { phrase: "leveraged", suggestion: "Replace with 'used' or name the tool" },
  { phrase: "spearheaded", suggestion: "Replace with 'led' or 'ran'" },
  { phrase: "facilitated", suggestion: "Replace with 'ran' or 'set up'" },
  { phrase: "synergies", suggestion: "Remove — be specific about what was achieved" },
  { phrase: "cutting-edge", suggestion: "Remove — name the actual technology" },
  { phrase: "thrilled to", suggestion: "Remove — state why the role is a fit instead" },
  { phrase: "dream job", suggestion: "Remove — be specific about role fit" },
  { phrase: "in today's fast-paced", suggestion: "Remove — generic filler" },
  { phrase: "highly motivated", suggestion: "Remove — show motivation through specifics" },
  { phrase: "detail-oriented", suggestion: "Remove — give an example instead" },
  { phrase: "look forward to", suggestion: "Remove — passive conclusion" },
  { phrase: "as an ai language model", suggestion: "This answer was generated and not cleaned" },
  { phrase: "delve into", suggestion: "Replace with 'explore', 'analyze', or be specific" },
  { phrase: "testament to", suggestion: "Remove — use direct statement" },
  { phrase: "i would love the opportunity", suggestion: "Remove — state specific interest directly" },
];

export function checkGenericPhrases(answer: string): ValidationFlag[] {
  const lower = answer.toLowerCase();
  const flags: ValidationFlag[] = [];
  for (const { phrase, suggestion } of GENERIC_PHRASES) {
    if (lower.includes(phrase)) {
      flags.push({
        code: "GENERIC_PHRASE",
        severity: "warning",
        message: `Generic phrase detected: "${phrase}". ${suggestion}.`,
        isHardFail: true, // Generic phrase block means it's an unqualified answer
      });
    }
  }
  return flags;
}

// ─────────────────────────────────────────────────────────────
// Check 2: Specificity check
// Free-text answers must reference at least one concrete element
// (a company name, technology, metric, date, or project name).
// ─────────────────────────────────────────────────────────────

const SPECIFICITY_SIGNALS = [
  /\b\d{4}\b/, // year
  /\b\d+\s*(%|x|ms|k|M|B|users?|requests?|hours?)\b/i, // metric
  /\b(built|shipped|led|ran|designed|deployed|launched|delivered|reduced|increased|improved)\b/i, // action verb with result
];

export function checkSpecificity(answer: string, category: QuestionCategory): ValidationFlag[] {
  if (category !== "free_text") return [];
  const wordCount = answer.trim().split(/\s+/).length;
  if (wordCount < 15) return []; // Short answers don't need deep proof points

  const hasSignal = SPECIFICITY_SIGNALS.some((p) => p.test(answer));
  if (!hasSignal) {
    return [{
      code: "LOW_SPECIFICITY",
      severity: "warning",
      message: "Answer lacks concrete specifics (metric, year, named technology, or action verb with outcome). Add a proof point.",
      isHardFail: true,
    }];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// Check 3: Length check
// ─────────────────────────────────────────────────────────────

export function checkAnswerLength(answer: string, category: QuestionCategory): ValidationFlag[] {
  const limit = WORD_LIMITS[category] ?? 80;
  const wordCount = answer.trim().split(/\s+/).length;

  if (wordCount > limit) {
    return [{
      code: "OVERLENGTH",
      severity: category === "yes_no" || category === "dropdown" ? "error" : "warning",
      message: `Answer is ${wordCount} words — exceeds ${limit}-word limit for ${category}. Trim.`,
    }];
  }

  if (wordCount < 3) {
    return [{
      code: "TOO_SHORT",
      severity: "warning",
      message: `Answer is very short (${wordCount} words). Verify it is complete.`,
    }];
  }

  return [];
}

// ─────────────────────────────────────────────────────────────
// Check 4: Tone check
// ─────────────────────────────────────────────────────────────

const PASSIVE_PATTERNS = [
  /\bwas responsible for\b/i,
  /\bwas involved in\b/i,
  /\bhelped (to|with)\b/i,
  /\bassisted (with|in)\b/i,
];

const EMOTIONAL_PATTERNS = [
  /\bthrilled\b/i,
  /\bpassionate\b/i,
  /\bexcited about\b/i,
  /\bdream (job|company|role)\b/i,
];

export function checkTone(answer: string, category: QuestionCategory): ValidationFlag[] {
  if (category === "yes_no" || category === "upload" || category === "dropdown") return [];
  const flags: ValidationFlag[] = [];

  for (const p of EMOTIONAL_PATTERNS) {
    if (p.test(answer)) {
      flags.push({
        code: "EMOTIONAL_TONE",
        severity: "warning",
        message: "Emotional language detected. Replace with specific proof point (Career-Ops tone rule).",
      });
      break;
    }
  }

  for (const p of PASSIVE_PATTERNS) {
    if (p.test(answer)) {
      flags.push({
        code: "PASSIVE_VOICE",
        severity: "info",
        message: "Passive phrasing detected. Prefer action verbs (built, led, shipped).",
      });
      break;
    }
  }

  return flags;
}

// ─────────────────────────────────────────────────────────────
// Check 5: Unsupported claim detection
// Detects numeric metrics in the answer that are NOT present in
// the provided profile facts. Surfaces as a warning, not an error,
// because the metric may be in profile text not passed to the checker.
// ─────────────────────────────────────────────────────────────

const METRIC_PATTERN = /\b(\d+(?:\.\d+)?)\s*(%|x|×|ms|s\b|k\b|M\b|B\b|users?|requests?|hours?|days?|weeks?|months?|tokens?)\b/gi;

function extractMetrics(text: string): string[] {
  return Array.from(text.matchAll(METRIC_PATTERN)).map((m) =>
    m[0].toLowerCase().replace(/\s+/g, " ")
  );
}

export function checkUnsupportedClaims(
  answer: string,
  profileFactTexts: string[]
): ValidationFlag[] {
  const answerMetrics = extractMetrics(answer);
  if (answerMetrics.length === 0) return [];

  const profileText = profileFactTexts.join(" ").toLowerCase();
  const unsupported = answerMetrics.filter(
    (metric) => !profileText.includes(metric.toLowerCase())
  );

  if (unsupported.length > 0) {
    return [{
      code: "UNSUPPORTED_METRIC",
      severity: "warning",
      message: `Metric(s) not found in profile: ${unsupported.join(", ")}. Verify before submitting.`,
      isHardFail: true,
    }];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// Check 6: Empty / near-empty detection (error-level)
// ─────────────────────────────────────────────────────────────

export function checkNotEmpty(answer: string, required: boolean): ValidationFlag[] {
  if (!answer || answer.trim().length === 0) {
    return [{
      code: "EMPTY_ANSWER",
      severity: required ? "error" : "warning",
      message: required
        ? "Required answer is empty. Manual input needed."
        : "Answer is empty. This field may be optional.",
      isHardFail: required,
    }];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// Composite validator
// ─────────────────────────────────────────────────────────────

export function validateAnswer(params: {
  answer: string;
  category: QuestionCategory;
  required: boolean;
  profileFactTexts: string[];
}): AnswerValidationResult {
  const { answer, category, required, profileFactTexts } = params;

  const allFlags: ValidationFlag[] = [
    ...checkNotEmpty(answer, required),
    ...checkAnswerLength(answer, category),
    ...checkGenericPhrases(answer),
    ...checkSpecificity(answer, category),
    ...checkTone(answer, category),
    ...checkUnsupportedClaims(answer, profileFactTexts),
  ];

  const hasHardFail = allFlags.some((f) => f.isHardFail);

  // If there are zero matching profile facts used in a long free_text answer, add a hard fail
  const wordsInAnswer = answer.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  const matchedFactWord = profileFactTexts.some(fact => {
    const factWords = fact.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    return factWords.some(fw => wordsInAnswer.includes(fw));
  });

  if (category === "free_text" && wordsInAnswer.length > 10 && !matchedFactWord) {
     allFlags.push({
       code: "ZERO_GROUNDING",
       severity: "warning",
       message: "Answer draws no vocabulary from the provided profile facts. Hallucination risk.",
       isHardFail: true,
     });
  }

  const hasError = allFlags.some((f) => f.severity === "error" || f.isHardFail);
  const hasWarning = allFlags.some((f) => f.severity === "warning");

  let reviewNote: string | null = null;
  if (hasError) {
    const firstError = allFlags.find((f) => f.severity === "error" || f.isHardFail);
    reviewNote = `⛔ ${firstError!.message}`;
  } else if (hasWarning) {
    const warnings = allFlags.filter((f) => f.severity === "warning");
    reviewNote = `⚠ ${warnings[0].message}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ""}`;
  }

  return { valid: !hasError, flags: allFlags, reviewNote };
}

// ─────────────────────────────────────────────────────────────
// Answer Scoring System (V4 explicit scoring model)
// ─────────────────────────────────────────────────────────────

export interface AnswerScore {
  total: number;
  breakdown: {
    relevance: number;
    grounding: number;
    specificity: number;
    clarity: number;
  };
}

export interface ScoreFactors {
  hasPriorDraft: boolean;
  confirmedSkillHits: number;
  totalConfirmedSkills: number;
  profileFactHits: number;
  totalProfileFacts: number;
  category: QuestionCategory;
  flags: ValidationFlag[];
  wordCount: number;
}

/**
 * Compute explicit deterministic score.
 * Total Score = Relevance (0.40) + Grounding (0.30) + Specificity (0.15) + Clarity (0.15)
 */
export function computeAnswerScore(factors: ScoreFactors): AnswerScore {
  // 1. Relevance (JD Skills & Prior Human Approval constraint)
  let relevance = 0;
  if (factors.hasPriorDraft) relevance += 0.20; // Hard approval baseline
  if (factors.totalConfirmedSkills > 0) {
    const rawHit = factors.confirmedSkillHits / factors.totalConfirmedSkills;
    relevance += Math.min(rawHit, 0.40); // Cap skill relevance
  } else {
    relevance += 0.20; // Default when JD has nothing to measure against
  }
  relevance = Math.min(relevance, 0.40);

  // 2. Grounding (Profile Fact references)
  let grounding = 0;
  if (factors.totalProfileFacts > 0) {
    const rawHit = factors.profileFactHits / Math.min(factors.totalProfileFacts, 5); // 5 facts is fully grounded
    grounding += Math.min(rawHit * 0.30, 0.30);
  } else {
    grounding += 0.15; // fallback
  }

  // Categories like yes_no are implicitly 100% grounded if they don't hallucinate
  if (factors.category !== "free_text") {
    grounding = 0.30;
  }

  // 3. Specificity
  let specificity = 0.15;
  const hasLowSpecificity = factors.flags.some(f => f.code === "LOW_SPECIFICITY");
  const hasUnsupportedMetric = factors.flags.some(f => f.code === "UNSUPPORTED_METRIC");
  if (hasLowSpecificity) specificity = 0;
  else if (hasUnsupportedMetric) specificity -= 0.10; // Hallucinated metrics hurt specificity validity

  // 4. Clarity
  let clarity = 0.15;
  const hasLengthWarning = factors.flags.some(f => f.code === "OVERLENGTH" || f.code === "TOO_SHORT");
  const hasToneWarning = factors.flags.some(f => f.code === "EMOTIONAL_TONE" || f.code === "PASSIVE_VOICE" || f.code === "GENERIC_PHRASE");
  if (hasLengthWarning) clarity -= 0.05;
  if (hasToneWarning) clarity -= 0.10;
  clarity = Math.max(0, clarity);

  // Hard penalty for errors
  const errorCount = factors.flags.filter((f) => f.severity === "error").length;
  if (errorCount > 0) {
     relevance *= 0.5;
     grounding *= 0.5;
  }

  const total = Math.round((relevance + grounding + specificity + clarity) * 100) / 100;

  return {
    total,
    breakdown: {
      relevance: Math.round(relevance * 100) / 100,
      grounding: Math.round(grounding * 100) / 100,
      specificity: Math.round(specificity * 100) / 100,
      clarity: Math.round(clarity * 100) / 100,
    }
  };
}

export function buildScoreFactors(params: {
  answer: string;
  category: QuestionCategory;
  hasPriorDraft: boolean;
  confirmedSkills: string[];
  profileFactTexts: string[];
  flags: ValidationFlag[];
}): ScoreFactors {
  const { answer, category, hasPriorDraft, confirmedSkills, profileFactTexts, flags } = params;
  const answerLower = answer.toLowerCase();
  const wordCount = answerLower.split(/\s+/).length;

  const confirmedSkillHits = confirmedSkills.filter((s) =>
    answerLower.includes(s.toLowerCase())
  ).length;

  const profileFactHits = profileFactTexts.filter((fact) => {
    const words = fact.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
    return words.some((w) => answerLower.includes(w));
  }).length;

  return {
    hasPriorDraft,
    confirmedSkillHits,
    totalConfirmedSkills: confirmedSkills.length,
    profileFactHits,
    totalProfileFacts: profileFactTexts.length,
    category,
    flags,
    wordCount
  };
}
