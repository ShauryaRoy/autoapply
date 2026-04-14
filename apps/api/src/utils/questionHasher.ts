/**
 * questionHasher.ts
 *
 * Stable, portable question hashing for the Live Apply pipeline.
 *
 * Problem being solved:
 *   Keying draft answers by raw question text is fragile. ATS platforms
 *   vary wording slightly across sessions (e.g. "Why this role?" vs
 *   "Why are you interested in this role?"). Pagination reloads may
 *   produce different whitespace or punctuation. A raw-text key means
 *   every wording variation creates a new draft entry — prior work is lost.
 *
 * Solution:
 *   1. Normalize the question text (lowercase, collapse whitespace,
 *      strip trailing punctuation, expand common abbreviations).
 *   2. Detect the semantic intent using a keyword fingerprint lookup.
 *   3. Hash the *normalized* form using SHA-256 (first 12 hex chars).
 *
 * The output `questionHash` is used as the storage key in
 * `JobDraftSession.questionsJson`. The original text is stored alongside
 * for display purposes only.
 *
 * Sources:
 *  - Career-Ops apply.md §Step 4 (question classification)
 *  - Career-Ops auto-pipeline.md §Generic Fallback Questions
 */

import crypto from "node:crypto";
import type { GoogleGenerativeAI } from "@google/generative-ai";

// ─────────────────────────────────────────────────────────────
// Core types — exported here and imported by all consumers
// ─────────────────────────────────────────────────────────────

/** Categories of application form questions */
export type QuestionCategory =
  | "free_text"
  | "yes_no"
  | "dropdown"
  | "salary"
  | "upload"
  | "unknown";


// ─────────────────────────────────────────────────────────────
// Semantic intent fingerprints
// Maps a canonical intent label → keyword sets that identify it.
// If a normalized question matches a fingerprint, the intent is
// used *instead of* the raw text for hashing. This means
// "Why are you interested in this role?" and "Why this position?"
// both hash to intent "why_role".
// ─────────────────────────────────────────────────────────────

export type QuestionIntent =
  | "why_role"
  | "why_company"
  | "relevant_experience"
  | "good_fit"
  | "how_did_you_hear"
  | "visa_sponsorship"
  | "work_authorization"
  | "relocation"
  | "salary_expectation"
  | "start_date"
  | "resume_upload"
  | "cover_letter_upload"
  | "cover_letter_text"
  | "linkedin_url"
  | "github_url"
  | "portfolio_url"
  | "phone_number"
  | "years_of_experience"
  | "custom"; // Unique questions with no known intent canonical

const INTENT_FINGERPRINTS: Array<{ intent: QuestionIntent; keywords: string[] }> = [
  {
    intent: "why_role",
    keywords: ["why this role", "why this position", "why interested", "interest in this role",
      "interest in this position", "why apply", "why do you want this", "motivation for"],
  },
  {
    intent: "why_company",
    keywords: ["why this company", "why us", "why work here", "why join", "why acme", "what draws you",
      "what attracts you", "why do you want to work at"],
  },
  {
    intent: "relevant_experience",
    keywords: ["relevant experience", "relevant project", "relevant achievement", "tell us about",
      "describe your experience", "background in", "work experience"],
  },
  {
    intent: "good_fit",
    keywords: ["good fit", "why should we hire", "what makes you", "unique qualification",
      "strengths", "suited for this role", "best candidate"],
  },
  {
    intent: "how_did_you_hear",
    keywords: ["how did you hear", "how did you find", "source of this", "where did you learn",
      "referral source"],
  },
  {
    intent: "visa_sponsorship",
    keywords: ["visa sponsorship", "require sponsorship", "need sponsorship", "work visa",
      "authorization to work", "employment authorization"],
  },
  {
    intent: "work_authorization",
    keywords: ["authorized to work", "right to work", "legally eligible", "work permit",
      "citizenship", "work authorization"],
  },
  {
    intent: "relocation",
    keywords: ["willing to relocate", "able to relocate", "open to relocation", "relocate for"],
  },
  {
    intent: "salary_expectation",
    keywords: ["salary expectation", "compensation expectation", "expected salary", "desired salary",
      "salary requirement", "pay expectation", "desired compensation"],
  },
  {
    intent: "start_date",
    keywords: ["start date", "available to start", "earliest start", "notice period", "when can you start"],
  },
  {
    intent: "resume_upload",
    keywords: ["upload resume", "attach resume", "upload cv", "resume file", "cv file"],
  },
  {
    intent: "cover_letter_upload",
    keywords: ["upload cover letter", "attach cover letter", "cover letter file"],
  },
  {
    intent: "cover_letter_text",
    keywords: ["cover letter", "covering letter", "write a cover", "write a letter"],
  },
  {
    intent: "linkedin_url",
    keywords: ["linkedin url", "linkedin profile", "linkedin.com"],
  },
  {
    intent: "github_url",
    keywords: ["github url", "github profile", "github.com"],
  },
  {
    intent: "portfolio_url",
    keywords: ["portfolio url", "portfolio link", "portfolio website", "personal website"],
  },
  {
    intent: "phone_number",
    keywords: ["phone number", "phone", "mobile number", "contact number"],
  },
  {
    intent: "years_of_experience",
    keywords: ["years of experience", "how many years", "years working", "years in the field"],
  },
];

// ─────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────

/**
 * Normalize a question string for stable hashing.
 *
 * Steps:
 *  1. Trim whitespace
 *  2. Lowercase
 *  3. Collapse multiple whitespace to single space
 *  4. Remove trailing punctuation (? . !)
 *  5. Expand common abbreviation patterns
 *  6. Remove leading symbols / numbering (e.g. "1. " or "• ")
 */
export function normalizeQuestionText(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width chars
    .replace(/^\d+[\.\)]\s+/, "") // leading "1. " or "1) "
    .replace(/^[•\-\*]\s+/, "") // leading bullet
    .replace(/\s+/g, " ")
    .replace(/[?!.]+$/, "") // trailing punctuation
    .replace(/\byou're\b/g, "you are")
    .replace(/\bit's\b/g, "it is")
    .replace(/\bwe're\b/g, "we are")
    .trim();
}

// ─────────────────────────────────────────────────────────────
// LLM Intent Classification
// ─────────────────────────────────────────────────────────────

const INTENT_VALUES = INTENT_FINGERPRINTS.map(f => f.intent);

/**
 * Batch classify an array of question strings using a lightweight LLM (e.g., flash).
 * Returns an array of canonical intents mapping to the input questions.
 */
export async function classifyQuestionsLLM(
  llm: ReturnType<InstanceType<typeof GoogleGenerativeAI>["getGenerativeModel"]>,
  questions: string[]
): Promise<QuestionIntent[]> {
  if (questions.length === 0) return [];
  
  const intentListStr = INTENT_VALUES.join(", ") + ", custom";
  const questionMapStr = questions.map((q, i) => `[ID: ${i}] ${q}`).join("\n");

  const prompt = `You are an expert mapping job application questions to strict canonical intents.
Match each question below to exactly ONE of these intents:
${intentListStr}

Rules:
- If no intent perfectly matches the semantic meaning of the question, use "custom".
- "why_role" applies to "Why this position?", "Why are you interested in this role?", etc.
- "relevant_experience" applies to "Describe your background", "Tell us about a project", etc.

Questions to map:
${questionMapStr}

Return ONLY a valid JSON array of strings in the EXACT SAME ORDER as the input IDs.
Example output: ["why_role", "custom", "salary_expectation"]
`;

  try {
    const result = await llm.generateContent(prompt);
    const raw = result.response.text().trim();
    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (Array.isArray(parsed) && parsed.length === questions.length) {
      return parsed.map(val => {
        const intent = String(val).toLowerCase() as QuestionIntent;
        return INTENT_VALUES.includes(intent as any) ? intent : "custom";
      });
    }
  } catch (error) {
    console.warn(`[questionHasher] LLM intent classification failed, falling back to keywords:`, error);
  }

  // Fallback to deterministic detection
  return questions.map(q => detectQuestionIntent(normalizeQuestionText(q)));
}

/**
 * Detect the semantic intent of a normalized question (Deterministic Fallback).
 * Returns "custom" if no fingerprint matches.
 */
export function detectQuestionIntent(normalized: string): QuestionIntent {
  for (const { intent, keywords } of INTENT_FINGERPRINTS) {
    if (keywords.some((kw) => normalized.includes(kw))) {
      return intent;
    }
  }
  return "custom";
}

// ─────────────────────────────────────────────────────────────
// Hash generation
// ─────────────────────────────────────────────────────────────

/**
 * Generate a stable question hash.
 * This can be used synchronously with a pre-detected intent.
 * 
 * If the intent is a known canonical (not "custom"), the hash is
 * derived from `intent` — making it invariant to wording variations.
 *
 * If the intent is "custom" (truly unique question), the hash is
 * derived from the normalized text.
 *
 * Returns: 12-character hex string (first 12 of SHA-256).
 */
export function hashQuestionWithIntent(raw: string, intent: QuestionIntent): { questionHash: string; normalized: string } {
  const normalized = normalizeQuestionText(raw);
  const hashInput = intent === "custom" ? normalized : intent;

  const questionHash = crypto
    .createHash("sha256")
    .update(hashInput)
    .digest("hex")
    .slice(0, 12);

  return { questionHash, normalized };
}

/** Legacy signature for fallback where intent is synchronously detected */
export function hashQuestion(raw: string): { questionHash: string; intent: QuestionIntent; normalized: string } {
  const normalized = normalizeQuestionText(raw);
  const intent = detectQuestionIntent(normalized);
  const { questionHash } = hashQuestionWithIntent(raw, intent);
  return { questionHash, intent, normalized };
}

// ─────────────────────────────────────────────────────────────
// Draft answer lookup with hash-based fallback
// ─────────────────────────────────────────────────────────────

export interface StoredDraftEntry {
  questionHash: string;
  questionText: string;
  answer: string;
  approvedAt?: string;
}

/**
 * Find a stored draft answer for a given question.
 *
 * Lookup strategy (in order):
 *  1. Exact hash match (primary)
 *  2. Normalized text match (fallback for legacy text-keyed records)
 *
 * Returns the matched answer string, or null if nothing found.
 */
export function findStoredAnswer(
  question: string,
  storedDrafts: StoredDraftEntry[]
): { answer: string; matchedBy: "hash" | "text" | null } {
  const { questionHash, normalized } = hashQuestion(question);

  // 1. Hash match
  const byHash = storedDrafts.find((d) => d.questionHash === questionHash);
  if (byHash) return { answer: byHash.answer, matchedBy: "hash" };

  // 2. Normalized text match (backwards-compat for legacy string-keyed sessions)
  const byText = storedDrafts.find(
    (d) => normalizeQuestionText(d.questionText) === normalized
  );
  if (byText) return { answer: byText.answer, matchedBy: "text" };

  return { answer: "", matchedBy: null };
}
