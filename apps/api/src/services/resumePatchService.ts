/**
 * resumePatchService.ts
 *
 * Resume Patch Engine — converts Career-Ops CV↔JD intelligence into
 * precise, bullet-level diff patches via LLM.
 *
 * Architecture:
 *   bulletMatcher.ts  → detects which bullets have patch opportunity + safe keywords
 *   [Gemini LLM]      → rewrites only the targeted keywords (no full rewrites)
 *   validator.ts      → rejects hallucinations, fabricated metrics, ATS violations
 *
 * Design principles (adapted from Career-Ops pdf.md):
 *  - "Inject keywords naturally into EXISTING achievements"
 *  - "NEVER add skills the candidate doesn't have. Only reformulate."
 *  - "Keywords from JD: distribute into first bullet of each role + Skills"
 *  - ATS: action verb first, no markdown, ASCII-safe
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { matchBulletToJd } from "../utils/bulletMatcher.js";
import { validatePatch } from "../utils/validator.js";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface ExperienceEntry {
  role: string;
  company: string;
  bullets: string[];
}

export interface PatchedBullet {
  /** The original, unmodified bullet text */
  original: string;
  /** The patched bullet (may equal original if no patch was applied) */
  updated: string;
  /** Keywords from the JD that were injected or emphasised */
  keywords_added: string[];
  /** True when the patch was applied; false when original is returned */
  patched: boolean;
  /** Reason the patch was skipped or rejected (only present when patched=false) */
  skip_reason?: string;
}

export interface ResumePatchResult {
  patched_bullets: PatchedBullet[];
  /** How many bullets were successfully patched vs total processed */
  stats: {
    total: number;
    patched: number;
    skipped: number;
    rejected: number;
  };
}

// ─────────────────────────────────────────────────────────────
// LLM Prompt Design
// Adapted from Career-Ops pdf.md § "Keyword injection strategy"
// ─────────────────────────────────────────────────────────────

function buildPatchPrompt(params: {
  bullet: string;
  presentKeywords: string[];
  injectableKeywords: string[];
  bulletDomain: string;
}): string {
  const { bullet, presentKeywords, injectableKeywords, bulletDomain } = params;

  return `You are a resume editor specialising in ATS optimisation.

## TASK
Patch the following resume bullet point by injecting missing keywords naturally.

## RULES (ALL MANDATORY)
1. DO NOT rewrite the bullet — ONLY enhance it.
2. DO NOT invent new technologies, companies, or metrics.
3. DO NOT add numbers or percentages that are not in the original.
4. DO NOT change the opening action verb.
5. DO NOT use markdown (no **, no *, no brackets).
6. DO NOT use first-person voice (no "I built", "I led").
7. Keep the same length — max 60% longer than the original.
8. Only inject keywords that fit naturally in the bullet's context.
9. The bullet's domain is: ${bulletDomain} — do not cross into unrelated domains.
10. If no natural injection point exists, return the original bullet UNCHANGED.

## CONTEXT
Bullet domain: ${bulletDomain}
Keywords already present (do NOT add duplicates): ${presentKeywords.length > 0 ? presentKeywords.join(", ") : "none"}
Keywords to inject if they fit naturally: ${injectableKeywords.length > 0 ? injectableKeywords.join(", ") : "none"}

## ORIGINAL BULLET
${bullet}

## OUTPUT FORMAT
Return ONLY valid JSON. No explanations. No markdown code fences.

{
  "updated_bullet": "<patched bullet as a single string>",
  "keywords_added": ["<only keywords that were actually injected>"]
}

If no keywords can be injected naturally, return:
{
  "updated_bullet": "${bullet.replace(/"/g, '\\"')}",
  "keywords_added": []
}`;
}

// ─────────────────────────────────────────────────────────────
// Single-bullet patch via LLM
// ─────────────────────────────────────────────────────────────

interface LlmPatchOutput {
  updated_bullet: string;
  keywords_added: string[];
}

async function patchBulletWithLLM(
  model: ReturnType<InstanceType<typeof GoogleGenerativeAI>["getGenerativeModel"]>,
  prompt: string,
  originalBullet: string
): Promise<LlmPatchOutput> {
  try {
    const result = await model.generateContent([prompt]);
    const raw = result.response.text().trim();

    // Strip markdown code fences if LLM added them despite instructions
    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as LlmPatchOutput;

    if (typeof parsed.updated_bullet !== "string" || !Array.isArray(parsed.keywords_added)) {
      throw new Error("Unexpected LLM response shape");
    }

    return parsed;
  } catch {
    // On any parse failure, return original unchanged
    return { updated_bullet: originalBullet, keywords_added: [] };
  }
}

// ─────────────────────────────────────────────────────────────
// Main service function
// ─────────────────────────────────────────────────────────────

export async function patchResume(params: {
  experience: ExperienceEntry[];
  skillsRequired: string[];
  keywords: string[];
  geminiApiKey: string;
  geminiModel?: string;
}): Promise<ResumePatchResult> {
  const {
    experience,
    skillsRequired,
    keywords,
    geminiApiKey,
    geminiModel = "gemini-2.0-flash",
  } = params;

  // Deduplicate and combine JD signals
  const allJdKeywords = [...new Set([...skillsRequired, ...keywords])];

  const patchedBullets: PatchedBullet[] = [];
  let patchedCount = 0;
  let skippedCount = 0;
  let rejectedCount = 0;

  // ── Initialise LLM ──────────────────────────────────────────
  const hasLLM = !!geminiApiKey;
  const llmModel = hasLLM
    ? new GoogleGenerativeAI(geminiApiKey).getGenerativeModel({ model: geminiModel })
    : null;

  // ── Process all bullets across all experience entries ────────
  for (const entry of experience) {
    for (const bullet of entry.bullets) {
      if (!bullet.trim()) {
        skippedCount++;
        continue;
      }

      // Step 1: Match bullet against JD keywords
      const matchResult = matchBulletToJd(bullet, allJdKeywords);

      // Step 2: Skip if no patch opportunity exists
      if (!matchResult.hasPatchOpportunity || matchResult.injectable.length === 0) {
        patchedBullets.push({
          original: bullet,
          updated: bullet,
          keywords_added: [],
          patched: false,
          skip_reason: matchResult.injectable.length === 0
            ? "No domain-compatible injectable keywords found"
            : "No patch opportunity detected",
        });
        skippedCount++;
        continue;
      }

      // Step 3: If no LLM available, return original with metadata
      if (!llmModel) {
        patchedBullets.push({
          original: bullet,
          updated: bullet,
          keywords_added: [],
          patched: false,
          skip_reason: "LLM unavailable — GEMINI_API_KEY not configured",
        });
        skippedCount++;
        continue;
      }

      // Step 4: Build and send prompt
      const prompt = buildPatchPrompt({
        bullet,
        presentKeywords: matchResult.present,
        injectableKeywords: matchResult.injectable.slice(0, 5), // cap at 5 to avoid over-stuffing
        bulletDomain: matchResult.detectedDomain,
      });

      const llmOutput = await patchBulletWithLLM(llmModel, prompt, bullet);

      // Step 5: Validate the LLM output
      const validation = validatePatch({
        original: bullet,
        patched: llmOutput.updated_bullet,
        injectableKeywords: matchResult.injectable,
      });

      if (!validation.valid) {
        // Validation failed → return original (safe fallback)
        patchedBullets.push({
          original: bullet,
          updated: bullet,
          keywords_added: [],
          patched: false,
          skip_reason: `Validation rejected: ${validation.rejectionReason}`,
        });
        rejectedCount++;
        continue;
      }

      // Step 6: Accept the patch
      const wasActuallyPatched = llmOutput.updated_bullet.trim() !== bullet.trim();

      patchedBullets.push({
        original: bullet,
        updated: llmOutput.updated_bullet,
        keywords_added: llmOutput.keywords_added,
        patched: wasActuallyPatched,
        ...(wasActuallyPatched ? {} : { skip_reason: "LLM returned original — no natural injection point" }),
      });

      if (wasActuallyPatched) {
        patchedCount++;
      } else {
        skippedCount++;
      }
    }
  }

  return {
    patched_bullets: patchedBullets,
    stats: {
      total: patchedBullets.length,
      patched: patchedCount,
      skipped: skippedCount,
      rejected: rejectedCount,
    },
  };
}
