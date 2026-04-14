/**
 * liveApplyService.ts  — v2 (Refactored)
 *
 * Live Apply Mode — context-aware application assistant.
 * Adapted from Career-Ops `modes/apply.md` and `auto-pipeline.md`.
 *
 * ═══════════════════════════════════════════════════════════════════
 * CHANGES FROM v1 (see autoapply-live-apply-refactor.md for full doc)
 * ═══════════════════════════════════════════════════════════════════
 *
 * 1. Question storage is now hash-based (questionHasher.ts)
 *    - Normalized + hashed by semantic intent, not raw text
 *    - Resilient to ATS wording changes, pagination, punctuation
 *
 * 2. Context compression (contextCompressor.ts)
 *    - JD compressed to ≤600 high-signal words
 *    - Profile facts filtered & ranked by JD relevance
 *    - No full profile dump to the LLM
 *
 * 3. Per-group generation with isolated retries
 *    - free_text questions generated separately from factual (yes_no/dropdown)
 *    - Each group has its own retry budget
 *    - A failure in one group does not block the others
 *
 * 4. Answer cache (in-memory, keyed by questionHash + context fingerprint)
 *    - Avoids redundant LLM calls for same question in same session
 *    - Explicit TTL and invalidation on profile update
 *
 * 5. Grounded confidence model (answerValidator.ts)
 *    - Multi-factor scoring: prior draft, skill overlap, profile grounding
 *    - Replaces LLM self-reported confidence values
 *
 * 6. Validation pipeline (answerValidator.ts)
 *    - 6 checks: generic phrases, specificity, length, tone, metrics, empty
 *    - Flags surfaced as reviewNotes in UI — human decides to edit or keep
 *
 * 7. Regeneration mode support
 *    - regenMode parameter: "shorter" | "more_technical" | "more_direct" |
 *      "more_confident" | "add_metrics"
 *    - Adds a regen modifier to the prompt for targeted refinement
 *
 * 8. Stored answers use StoredDraftEntry shape (hash + text + approvedAt)
 *    - Backwards-compatible with v1 text-keyed records
 *
 * Logic sources:
 *  - career-ops/modes/apply.md      (8-step workflow)
 *  - career-ops/modes/auto-pipeline.md §Step4, §Tone
 *  - career-ops/modes/_shared.md    (NEVER list, ATS rules)
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import crypto from "node:crypto";
import {
  hashQuestionWithIntent,
  classifyQuestionsLLM,
  findStoredAnswer,
  type StoredDraftEntry,
  type QuestionIntent,
} from "../utils/questionHasher.js";
import {
  buildCompressedContext,
  formatCompressedContextForPrompt,
  type CompressedContext,
  type ProfileSnapshot,
} from "../utils/contextCompressor.js";
import {
  validateAnswer,
  computeAnswerScore,
  buildScoreFactors,
  type AnswerScore,
  type ValidationFlag,
} from "../utils/answerValidator.js";

// ─────────────────────────────────────────────────────────────
// Re-export canonical types for route layer
// ─────────────────────────────────────────────────────────────

export type { ProfileSnapshot, StoredDraftEntry };

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type QuestionCategory =
  | "free_text"
  | "yes_no"
  | "dropdown"
  | "salary"
  | "upload"
  | "unknown";

export type RegenMode =
  | "shorter"
  | "more_technical"
  | "more_direct"
  | "more_confident"
  | "add_metrics"
  | null;

/** A single question detected on the live application page */
export interface DetectedQuestion {
  questionText: string;
  category: QuestionCategory;
  fieldHint?: string;
  required: boolean;
  options?: string[];
}

/** Per-question result from the pipeline */
export interface DraftAnswer {
  /** Original question text (for display) */
  questionText: string;
  /** Stable hash used as storage key */
  questionHash: string;
  /** Detected semantic intent */
  intent: QuestionIntent;
  /** Normalized question text */
  normalizedText: string;
  /** Selected final answer text */
  answer: string;
  /** Generated candidates (v3: top answers before selection) */
  candidates?: string[];
  /**
  /**
   * V4 Deterministic Answer Score detailing relevance, grounding, specificity, and clarity
   */
  score: AnswerScore;
  /** True when answer was derived from a stored human-approved draft */
  fromPriorDraft: boolean;
  /** Validation flags (info + warning + error) */
  flags: ValidationFlag[];
  /** Single-line note for UI review panel, or null if clean */
  reviewNote: string | null;
}

/** Input to the live apply pipeline */
export interface LiveApplyInput {
  jobUrl: string;
  jobTitle: string;
  companyName: string;
  jobDescriptionText: string;
  visibleQuestions: DetectedQuestion[];
  /** Stored draft entries from JobDraftSession.questionsJson */
  storedDraftEntries?: StoredDraftEntry[];
  /** Globally learned answers for the active user (v3) */
  learnedAnswers?: Array<{ intent: string; answerText: string }>;
  profileSnapshot: ProfileSnapshot;
  jobAnalysis?: {
    matchedSkills: string[];
    missingSkills: string[];
    archetype?: string;
    score?: number;
  };
  /** Regeneration modifier — targets a single question for refinement */
  regenMode?: RegenMode;
  /** If set, only regenerate this specific question (by hash) */
  regenQuestionHash?: string;
  geminiApiKey: string;
  geminiModel?: string;
}

/** Full output from the pipeline */
export interface LiveApplyOutput {
  company: string;
  role: string;
  /** SHA-256(jobUrl::company::role)[0:16] */
  sessionId: string;
  roleChanged?: { from: string; to: string };
  answers: DraftAnswer[];
  contextConfidence: number;
  usedGenericFallback: boolean;
  /** Estimated chars sent to LLM (for token monitoring) */
  contextCharEstimate: number;
}

// ─────────────────────────────────────────────────────────────
// Generic Fallback Questions (Career-Ops auto-pipeline.md §Generic)
// ─────────────────────────────────────────────────────────────

const GENERIC_FALLBACK_QUESTIONS: DetectedQuestion[] = [
  { questionText: "Why are you interested in this role?", category: "free_text", required: true },
  { questionText: "Why do you want to work at [Company]?", category: "free_text", required: false },
  { questionText: "Tell us about a relevant project or achievement.", category: "free_text", required: false },
  { questionText: "What makes you a good fit for this position?", category: "free_text", required: false },
  {
    questionText: "How did you hear about this role?",
    category: "dropdown",
    required: false,
    options: ["LinkedIn", "Job Board", "Company Website", "Referral", "Other"],
  },
];

// ─────────────────────────────────────────────────────────────
// Career-Ops Tone Rules (verbatim from auto-pipeline.md §Tone)
// ─────────────────────────────────────────────────────────────

const TONE_RULES = `
## Tone Rules (MANDATORY — Career-Ops "I'm choosing you" framework)
- Position: Confident candidate who has options and chose this company deliberately.
- Confident without arrogance: "I've spent two years building production AI agent systems — your role is where I want to apply that next."
- Selective without snobbery: "I've been deliberate about finding a team where I can contribute meaningfully from day one."
- Specific and concrete: Always reference something REAL from the JD or company, and something REAL from the candidate's experience.
- Direct, no fluff: 2-4 sentences max per answer. No "I'm passionate about..." or "I would love the opportunity to..."
- The hook is the proof, not the affirmation: Instead of "I'm great at X", say "I built X that does Y."

## Per-Question Answer Framework
- why_role: "Your [specific JD requirement] maps directly to [specific experience I have]."
- why_company: Cite something concrete about the company. "I've been following [product/initiative] since [timeframe]."
- relevant_experience: One quantified proof point max. "Built [X] that [metric/outcome]."
- good_fit: "I sit at the intersection of [A] and [B], which is exactly where this role lives."
- how_did_you_hear: Honest. "Found through [channel], evaluated against my criteria, ranked highly."
- yes_no: Factual. "Yes." or "No." — no elaboration unless the question explicitly asks.
- salary: "My range is [X–Y] based on market data for this role." Fallback: "Open to discussion."
- upload: "Resume attached." or "Cover letter attached."

## NEVER
- Invent experience or metrics not present in the profile
- Use: passionate, thrilled, dream job, results-oriented, proven track record
- Use: leveraged, spearheaded, facilitated, synergies, robust, cutting-edge
- Write more than 100 words for any free-text answer
`.trim();

// ─────────────────────────────────────────────────────────────
// Regeneration Mode Modifiers
// ─────────────────────────────────────────────────────────────

const REGEN_MODIFIERS: Record<NonNullable<RegenMode>, string> = {
  shorter: "Rewrite the answer to be shorter. Target 2 sentences maximum. Keep all specifics.",
  more_technical: "Rewrite the answer to be more technical. Name specific technologies, frameworks, or methods. Remove vague language.",
  more_direct: "Rewrite the answer to be more direct. Remove any hedging. Start with the strongest statement.",
  more_confident: "Rewrite the answer to project more confidence. Use definitive language. No qualifiers like 'somewhat', 'fairly', 'helped with'.",
  add_metrics: "Rewrite the answer to include a specific metric or outcome from the profile. If no metric is available, note: '[metric needed]'.",
};

// ─────────────────────────────────────────────────────────────
// Answer Cache
// ─────────────────────────────────────────────────────────────

interface CacheEntry {
  answer: string;
  generatedAt: number;
}

// ─────────────────────────────────────────────────────────────
// Versioning & Caching
// ─────────────────────────────────────────────────────────────

const PROMPT_VERSION = "v4.0";
const CLASSIFIER_VERSION = "v4.0";
const TEMPLATE_VERSION = "v4.0";

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * In-memory answer cache.
 * Key: `${questionHash}::${contextFingerprint}`
 * where contextFingerprint is SHA-256(confirmedSkills + jdSummary + profile + versions)
 */
const answerCache = new Map<string, CacheEntry>();

function buildContextFingerprint(ctx: CompressedContext, profileSnapshot: ProfileSnapshot, regenMode: RegenMode): string {
  const profileFootprint = crypto.createHash("sha256").update(JSON.stringify(profileSnapshot)).digest("hex").slice(0, 8);
  const raw = `${ctx.confirmedSkills.join("|")}::${ctx.jdSummary.slice(0, 200)}::${profileFootprint}::${regenMode ?? "none"}::${PROMPT_VERSION}::${CLASSIFIER_VERSION}::${TEMPLATE_VERSION}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

function getCachedAnswer(questionHash: string, fingerprint: string): string | null {
  const key = `${questionHash}::${fingerprint}`;
  const entry = answerCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.generatedAt > CACHE_TTL_MS) {
    answerCache.delete(key);
    return null;
  }
  return entry.answer;
}

function setCachedAnswer(questionHash: string, fingerprint: string, answer: string): void {
  const key = `${questionHash}::${fingerprint}`;
  answerCache.set(key, { answer, generatedAt: Date.now() });
}

/** Invalidate all cache entries for a given context fingerprint. */
export function invalidateAnswerCache(fingerprint: string): void {
  for (const key of answerCache.keys()) {
    if (key.endsWith(`::${fingerprint}`)) {
      answerCache.delete(key);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Session ID
// ─────────────────────────────────────────────────────────────

export function buildSessionId(jobUrl: string, companyName: string, jobTitle: string): string {
  return crypto
    .createHash("sha256")
    .update(`${jobUrl}::${companyName.toLowerCase()}::${jobTitle.toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

// ─────────────────────────────────────────────────────────────
// Prompt builders (one per question group)
// ─────────────────────────────────────────────────────────────

function buildFreeTextPrompt(params: {
  contextBlock: string;
  questions: Array<{ q: DetectedQuestion; prior: string | null; regenMode: RegenMode; intent?: string; }>;
  learnedAnswers?: Array<{ intent: string; answerText: string }>;
}): string {
  const { contextBlock, questions } = params;

  const questionsBlock = questions
    .map(({ q, prior, regenMode, intent }, i) => {
      const regenNote = regenMode
        ? `  [Regeneration instruction: ${REGEN_MODIFIERS[regenMode]}]\n`
        : "";
      const priorNote = prior
        ? `  [Prior human-approved draft: "${prior.slice(0, 120)}${prior.length > 120 ? "…" : ""}"]\n`
        : "";
      return (
        `Q${i + 1} [Intent: ${intent || q.category}${q.required ? " REQUIRED" : ""}]: ${q.questionText}\n` +
        regenNote +
        priorNote
      );
    })
    .join("\n");

  let learnedBlock = "";
  if (params.learnedAnswers && params.learnedAnswers.length > 0) {
    const list = params.learnedAnswers.map((l) => `[Intent: ${l.intent}] ${l.answerText}`).join("\n");
    learnedBlock = `\n## Candidate's Past Approved Answers\nUse these to adapt your tone and structure, reusing elements if they match the current JD:\n${list}\n`;
  }

  return `You are an expert job application assistant. Generate copy-paste-ready answers strictly following template constraints.

${contextBlock}${learnedBlock}

## V4 System Instructions & Session Constraints
TONE: Direct, punchy, confident. No fluff. Cohesive style across all answers.

## Intent Templates
To ensure deterministic output, you must map your answer to the following sentence structures based on the Intent:
- [why_role]: Sentence 1: Direct alignment with JD requirement. Sentence 2: Specific proof from experience. Sentence 3: Forward-looking contribution.
- [why_company]: Sentence 1: Cite explicit company fact or JD detail. Sentence 2: Connect to personal/professional interest. Sentence 3: State expected impact.
- [experience]: Sentence 1: Role and context. Sentence 2: Action taken. Sentence 3: Quantified outcome.
- [achievement]: Sentence 1: The challenge/goal. Sentence 2: Action taken (skills used). Sentence 3: Quantified outcome.
- [good_fit]: Sentence 1: Highlight intersection of two relevant skills from JD. Sentence 2: Cite specific past achievement leveraging both. Sentence 3: Conclude fit.
- [custom / other]: Sentence 1: Direct answer. Sentence 2: Specific proof or example. Sentence 3: Concise conclusion.

## Questions to Answer
${questionsBlock}

## Output Requirements
For EACH question, return exactly one JSON object in the array:
- "questionText": exact question text as written above
- "candidates": an array of EXACTLY TWO distinct candidate answers. Candidate A MUST be highly technical and factual. Candidate B MUST focus on business impact and outcomes. They must NOT be near-duplicates.
- "reviewNotes": a single-sentence note for the human reviewer if anything needs attention, otherwise null

RULES:
- Free-text answers: 2-4 sentences max.
- MUST explicitly use the Intent Template structure.
- MUST explicitly include at least 1 concrete example/metric from the profile facts.
- DO NOT use banned phrases (e.g. "I'm passionate about", "I'm a good fit because").
- Cite only facts present in the Relevant Experience / Skills sections. NEVER invent metrics or companies.
- If a prior draft is given, refine it.

Return ONLY a valid JSON array. No markdown fences. No explanation outside the array.

[
  {
    "questionText": "...",
    "candidates": ["...", "..."],
    "reviewNotes": null
  }
]`;
}

function buildFactualPrompt(params: {
  contextBlock: string;
  questions: Array<{ q: DetectedQuestion; prior: string | null }>;
}): string {
  const { contextBlock, questions } = params;

  const questionsBlock = questions
    .map(({ q, prior }, i) => {
      const priorNote = prior ? `  [Prior draft: "${prior}"]\n` : "";
      const optionsNote = q.options?.length
        ? `  Options: ${q.options.join(" | ")}\n`
        : "";
      return (
        `Q${i + 1} [${q.category}${q.required ? " REQUIRED" : ""}]: ${q.questionText}\n` +
        priorNote +
        optionsNote
      );
    })
    .join("\n");

  return `You are an expert job application assistant. Answer factual form questions.

${contextBlock}

## Questions to Answer
${questionsBlock}

## Instructions
- yes_no: Answer "Yes." or "No." only, based on profile data. If unknown, write "Yes." and add a reviewNote.
- dropdown: Pick the single best option from the listed options.
- salary: If salary data is in profile, give a range. Otherwise: "Open to discussion."
- upload: "Resume attached." or "Cover letter attached."
- Answer each question factually and concisely (≤10 words).

Return ONLY a valid JSON array. No markdown fences.

[
  {
    "questionText": "...",
    "answer": "...",
    "reviewNotes": null
  }
]`;
}

// ─────────────────────────────────────────────────────────────
// Single-question LLM call (for targeted regen)
// ─────────────────────────────────────────────────────────────

async function generateSingleAnswer(
  llm: ReturnType<InstanceType<typeof GoogleGenerativeAI>["getGenerativeModel"]>,
  params: {
    contextBlock: string;
    question: DetectedQuestion;
    priorAnswer: string | null;
    regenMode: RegenMode;
    maxRetries: number;
  }
): Promise<{ answer: string; reviewNotes: string | null }> {
  const { contextBlock, question, priorAnswer, regenMode, maxRetries } = params;
  const isFactual =
    question.category === "yes_no" ||
    question.category === "dropdown" ||
    question.category === "upload" ||
    question.category === "salary";

  const prompt = isFactual
    ? buildFactualPrompt({ contextBlock, questions: [{ q: question, prior: priorAnswer }] })
    : buildFreeTextPrompt({
        contextBlock,
        questions: [{ q: question, prior: priorAnswer, regenMode }],
      });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await llm.generateContent([prompt]);
      const raw = result.response.text().trim();
      const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Empty array");
      const { answer, reviewNotes } = parsed[0];
      if (!answer || typeof answer !== "string") throw new Error("No answer field");
      return { answer: answer.trim(), reviewNotes: reviewNotes ?? null };
    } catch (err: any) {
      if (attempt >= maxRetries) {
        return {
          answer: priorAnswer ?? "",
          reviewNotes: `Generation failed after ${maxRetries} attempts: ${err.message}`,
        };
      }
    }
  }
  return { answer: priorAnswer ?? "", reviewNotes: "Generation failed." };
}

// ─────────────────────────────────────────────────────────────
// Group batch generation with isolated retries per group
// ─────────────────────────────────────────────────────────────

interface RawGeneratedAnswer {
  questionText: string;
  answer?: string; // Factual output single answer
  candidates?: string[]; // Free-text outputs multiple candidates
  reviewNotes: string | null;
}

async function generateGroup(
  llm: ReturnType<InstanceType<typeof GoogleGenerativeAI>["getGenerativeModel"]>,
  groupType: "free_text" | "factual",
  contextBlock: string,
  items: Array<{
    q: DetectedQuestion;
    prior: string | null;
    regenMode: RegenMode;
    intent?: string;
  }>,
  maxRetries: number,
  learnedAnswers?: Array<{ intent: string; answerText: string }>
): Promise<RawGeneratedAnswer[]> {
  if (items.length === 0) return [];

  const prompt =
    groupType === "free_text"
      ? buildFreeTextPrompt({ contextBlock, questions: items, learnedAnswers })
      : buildFactualPrompt({ contextBlock, questions: items.map(({ q, prior }) => ({ q, prior })) });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await llm.generateContent([prompt]);
      const raw = result.response.text().trim();
      const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error("LLM returned non-array JSON");
      return parsed as RawGeneratedAnswer[];
    } catch (err: any) {
      console.warn(`[LiveApply][${groupType}] Attempt ${attempt} failed: ${err.message}`);
      if (attempt >= maxRetries) {
        console.error(`[LiveApply][${groupType}] All ${maxRetries} attempts exhausted`);
        // Return empty — each question will fall back to prior draft or empty
        return [];
      }
    }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// Main Service Function
// ─────────────────────────────────────────────────────────────

export async function runLiveApply(input: LiveApplyInput): Promise<LiveApplyOutput> {
  const {
    jobUrl,
    jobTitle,
    companyName,
    jobDescriptionText,
    visibleQuestions,
    storedDraftEntries = [],
    profileSnapshot,
    jobAnalysis,
    regenMode = null,
    regenQuestionHash = undefined,
    geminiApiKey,
    geminiModel = "gemini-2.0-flash",
  } = input;

  if (!geminiApiKey) throw new Error("[LiveApply] geminiApiKey is required.");

  // ── Step 1: Resolve questions ────────────────────────────────
  const usedGenericFallback = visibleQuestions.length === 0;
  const questions: DetectedQuestion[] = usedGenericFallback
    ? GENERIC_FALLBACK_QUESTIONS.map((q) => ({
        ...q,
        questionText: q.questionText.replace("[Company]", companyName),
      }))
    : visibleQuestions;

  // ── Step 2: Session ID ───────────────────────────────────────
  const sessionId = buildSessionId(jobUrl, companyName, jobTitle);

  // ── Step 3: Build compressed context ────────────────────────
  const compressedCtx = buildCompressedContext({
    company: companyName,
    role: jobTitle,
    jobDescriptionText,
    profile: profileSnapshot,
    jobAnalysis,
  });

  const contextFingerprint = buildContextFingerprint(compressedCtx, profileSnapshot, regenMode);
  const contextBlock = formatCompressedContextForPrompt(compressedCtx, profileSnapshot);

  // ── Step 4: Hash all questions + load prior drafts ───────────
  const llm = new GoogleGenerativeAI(geminiApiKey).getGenerativeModel({ model: geminiModel });

  const intentMapping = await classifyQuestionsLLM(llm, questions.map(q => q.questionText));

  const hashedQuestions = questions.map((q, idx) => {
    const intent = intentMapping[idx];
    const { questionHash, normalized } = hashQuestionWithIntent(q.questionText, intent);
    const { answer: priorAnswer, matchedBy } = findStoredAnswer(q.questionText, storedDraftEntries);
    return { q, questionHash, intent, normalized, priorAnswer: priorAnswer || null, matchedBy };
  });

  // ── Step 5: Group questions by type ─────────────────────────
  const FACTUAL_CATEGORIES: QuestionCategory[] = ["yes_no", "dropdown", "upload", "salary"];

  const freeTextItems = hashedQuestions.filter(
    ({ q, questionHash }) =>
      !FACTUAL_CATEGORIES.includes(q.category) &&
      (regenQuestionHash === undefined || questionHash === regenQuestionHash)
  );
  const factualItems = hashedQuestions.filter(
    ({ q, questionHash }) =>
      FACTUAL_CATEGORIES.includes(q.category) &&
      (regenQuestionHash === undefined || questionHash === regenQuestionHash)
  );

  // ── Step 6: Check cache then generate per group ──────────────
  const MAX_RETRIES = 2;

  // For each free-text item: check cache first, skip generation if cached
  const uncachedFreeText = freeTextItems.filter(({ questionHash }) => {
    if (regenMode) return true; // Always regenerate on regen request
    return getCachedAnswer(questionHash, contextFingerprint) === null;
  });

  const [freeTextRaw, factualRaw] = await Promise.all([
    generateGroup(
      llm,
      "free_text",
      contextBlock,
      uncachedFreeText.map(({ q, priorAnswer, intent }) => ({
        q,
        prior: priorAnswer,
        regenMode: regenMode ?? null,
        intent
      })),
      MAX_RETRIES,
      input.learnedAnswers
    ),
    generateGroup(
      llm,
      "factual",
      contextBlock,
      factualItems.map(({ q, priorAnswer }) => ({
        q,
        prior: priorAnswer,
        regenMode: null,
      })),
      MAX_RETRIES
    ),
  ]);

  // Cache newly generated free-text answers
  for (const raw of freeTextRaw) {
    const hq = hashedQuestions.find(
      (h) => h.q.questionText.trim() === raw.questionText?.trim()
    );
    if (hq && raw.answer) {
      setCachedAnswer(hq.questionHash, contextFingerprint, raw.answer);
    }
  }

  // ── Step 7: Merge results + validate + score + refine ────────
  const allRaw: RawGeneratedAnswer[] = [...freeTextRaw, ...factualRaw];
  const profileFactTexts = compressedCtx.relevantProfileFacts.map((f) => f.text);

  const answers: DraftAnswer[] = await Promise.all(hashedQuestions.map(
    async ({ q, questionHash, intent, normalized, priorAnswer }) => {
      // Find generated result
      let generatedAnswer = allRaw.find(
        (r) => r.questionText?.trim() === q.questionText.trim()
      );

      // Try cache hit for free-text (cached from prior session)
      const cached = !FACTUAL_CATEGORIES.includes(q.category) && !regenMode
        ? getCachedAnswer(questionHash, contextFingerprint)
        : null;

      // Resolve final answer text via candidate evaluation
      let answerText = "";
      let candidatesList: string[] | undefined = undefined;
      let llmReviewNotes: string | null = null;
      let fromGen = false;

      if (generatedAnswer?.candidates && generatedAnswer.candidates.length > 0) {
        // Multi-candidate path (free_text)
        fromGen = true;
        candidatesList = generatedAnswer.candidates.map(c => c.trim()).filter(c => c.length > 0);
        llmReviewNotes = generatedAnswer.reviewNotes ?? null;
        
        if (candidatesList.length === 0 && generatedAnswer.answer) {
           candidatesList = [generatedAnswer.answer.trim()];
        }

        if (candidatesList.length > 0) {
          // Evaluate candidates to pick the best one
          const evaluated = candidatesList.map(candText => {
            const val = validateAnswer({ answer: candText, category: q.category, required: q.required, profileFactTexts });
            const scoreObj = computeAnswerScore(buildScoreFactors({
              answer: candText, category: q.category, hasPriorDraft: !!priorAnswer, confirmedSkills: compressedCtx.confirmedSkills, profileFactTexts, flags: val.flags
            }));
            const hardFailCount = val.flags.filter(f => f.isHardFail).length;
            const errCount = val.flags.filter(f => f.severity === "error").length;
            return { candText, val, scoreObj, hardFailCount, errCount };
          });

          // Sort by fewest hard fails, fewest errors, highest score
          evaluated.sort((a, b) => {
             if (a.hardFailCount !== b.hardFailCount) return a.hardFailCount - b.hardFailCount;
             if (a.errCount !== b.errCount) return a.errCount - b.errCount;
             return b.scoreObj.total - a.scoreObj.total;
          });

          answerText = evaluated[0].candText;
        }
      } else if (generatedAnswer?.answer) {
        // Single candidate path (factual)
        fromGen = true;
        answerText = generatedAnswer.answer.trim();
        llmReviewNotes = generatedAnswer.reviewNotes ?? null;
      } else if (cached) {
        answerText = cached;
      } else if (priorAnswer) {
        answerText = priorAnswer;
        llmReviewNotes = "Using prior approved draft — LLM generation missed this question.";
      }

      // Base Validation
      let validation = validateAnswer({
        answer: answerText,
        category: q.category,
        required: q.required,
        profileFactTexts,
      });

      // Refinement Loop (V3: Auto-refine if hard fail)
      let finalHasHardFail = validation.flags.some(f => f.isHardFail);
      
      if (fromGen && finalHasHardFail && q.category === "free_text") {
         const refinePrompt = `The following generated answer was rejected for a job application because: "${validation.reviewNote}".
         
Original Question: "${q.questionText}"
Rejected Answer: "${answerText}"

Instruction: Rewrite this answer to explicitly fix the failure reason. Keep it under 4 sentences. Make it direct. `;
         
         try {
           const refineResult = await llm.generateContent(refinePrompt);
           const refinedRaw = refineResult.response.text().trim();
           if (refinedRaw.length > 10) {
             answerText = refinedRaw;
             validation = validateAnswer({ answer: answerText, category: q.category, required: q.required, profileFactTexts });
             llmReviewNotes = "(Auto-Refined) " + (llmReviewNotes || "");
           }
         } catch (e) {
           console.warn("[LiveApply] Refinement loop failed for question", q.questionText);
         }
      }

      // Grounded confidence scoring (recompute after possible refinement)
      const scoreFactors = buildScoreFactors({
        answer: answerText,
        category: q.category,
        hasPriorDraft: !!priorAnswer,
        confirmedSkills: compressedCtx.confirmedSkills,
        profileFactTexts,
        flags: validation.flags,
      });
      const finalScore = computeAnswerScore(scoreFactors);

      // Merge review notes (LLM note + validation note)
      const reviewNote =
        validation.reviewNote
          ? llmReviewNotes
            ? `${validation.reviewNote} | ${llmReviewNotes}`
            : validation.reviewNote
          : llmReviewNotes ?? null;

      return {
        questionText: q.questionText,
        questionHash,
        intent,
        normalizedText: normalized,
        category: q.category,
        answer: answerText,
        candidates: candidatesList,
        score: finalScore,
        fromPriorDraft: !!priorAnswer && !fromGen,
        flags: validation.flags,
        reviewNote,
      };
    }
  ));

  // ── Step 8: Compute overall score ──────────────────────
  const contextConfidence =
    answers.length > 0
      ? Math.round(
          (answers.reduce((sum, a) => sum + a.score.total, 0) / answers.length) * 100
        ) / 100
      : 0;

  return {
    company: companyName,
    role: jobTitle,
    sessionId,
    answers,
    contextConfidence,
    usedGenericFallback,
    contextCharEstimate: compressedCtx.estimatedContextChars,
  };
}

export { classifyConfidence };

function classifyConfidence(score: number): "high" | "medium" | "low" {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  return "low";
}
