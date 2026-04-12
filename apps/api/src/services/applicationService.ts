/**
 * applicationService.ts
 *
 * Application Intelligence Service — generates context-aware, short, precise
 * application answers using job analysis and patched resume bullets.
 *
 * Adapts Career-Ops Block E (Personalisation) & Block F (STAR stories)
 * into a pipeline-friendly structure.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import crypto from "node:crypto";
import { buildApplicationContext, formatContextForPrompt, AppContextParams } from "../utils/contextBuilder.js";
import { 
  validateApplicationAnswers, 
  checkWordLimit, 
  checkStructuredWhyRole, 
  checkToneConsistency 
} from "../utils/validator.js";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface ApplicationAnswers {
  summary: string;
  why_role: string;
  answers: {
    why_company: string;
    strengths: string;
    experience: string;
    custom: Record<string, string>;
  };
  confidence: number;
}

// ─────────────────────────────────────────────────────────────
// Caching Layer (Lightweight in-memory)
// ─────────────────────────────────────────────────────────────

const responseCache = new Map<string, ApplicationAnswers>();

function generateCacheKey(jobKeywords: string[], topBullets: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(jobKeywords.join("|") + "---" + topBullets.join("|"));
  return hash.digest("hex");
}

// ─────────────────────────────────────────────────────────────
// LLM Prompt Design
// ─────────────────────────────────────────────────────────────

function buildGenerationPrompt(contextString: string): string {
  return `You are a strict, top-tier executive recruiter drafting form application answers for a candidate.

## TASK
Generate short, highly precise, human-sounding answers based EXACTLY on the provided context.

## RULES (MANDATORY)
1. TONE: Direct, concise, professional. No emotional language ("passionate", "thrilled"). No generic AI boilerplate ("delve into", "testament to").
2. DO NOT hallucinate skills or experience.
3. CONCISENESS: Strict max 80 words per answer. Keep it 2-4 lines MAXIMUM.
4. STRUCTURED WHY ROLE: "why_role" MUST follow this exact structure: (a) reference a specific responsibility/problem from the JD, (b) connect it to the user's experience, (c) mention an expected outcome/impact.
5. Return ONLY valid JSON format matching the schema exactly. No markdown fences.

## CONTEXT
${contextString}

## RESPONSE SCHEMA
{
  "summary": "<2-3 lines: direct professional summary of strengths>",
  "why_role": "<structured 3-part answer: JD problem -> user exp -> impact>",
  "answers": {
    "why_company": "<1-2 lines referencing company domain/product>",
    "custom": {}
  }
}`;
}

// ─────────────────────────────────────────────────────────────
// Service Function
// ─────────────────────────────────────────────────────────────

export async function generateApplicationAnswers(
  params: AppContextParams & { geminiApiKey: string; geminiModel?: string; maxRetries?: number }
): Promise<ApplicationAnswers> {
  const { geminiApiKey, geminiModel = "gemini-2.0-flash", maxRetries = 2, ...contextParams } = params;

  if (!geminiApiKey) {
    throw new Error("Application intelligence requires geminiApiKey");
  }

  const ctx = buildApplicationContext(contextParams);
  const contextString = formatContextForPrompt(ctx);
  const jobKeywords = [...ctx.matchedSkills, ...ctx.missingSkills];
  
  // Cache check
  const cacheKey = generateCacheKey(jobKeywords, ctx.resumeHighlights);
  const cached = responseCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const llmModel = new GoogleGenerativeAI(geminiApiKey).getGenerativeModel({ model: geminiModel });
  const prompt = buildGenerationPrompt(contextString);

  let attempt = 0;
  let lastError = "";

  while (attempt <= maxRetries) {
    attempt++;
    try {
      const result = await llmModel.generateContent([prompt]);
      const raw = result.response.text().trim();
      const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      
      const parsed = JSON.parse(cleaned) as {
        summary: string;
        why_role: string;
        answers: { why_company: string; custom: Record<string, string> };
      };

      if (!parsed.summary || !parsed.why_role || !parsed.answers) {
        throw new Error("Invalid schema structure from LLM");
      }

      // Hybrid Generation: Combine LLM outputs with minimal-LLM structured output for strengths & experience
      const strengthsTemplate = ctx.matchedSkills.length > 0
        ? `My core strengths directly align with the requirements for this role, specifically in ${ctx.matchedSkills.slice(0, 3).join(", ")}.`
        : "My core strengths are rooted in my hands-on background and technical problem-solving.";
        
      const experienceTemplate = ctx.resumeHighlights.length > 0 
        ? ctx.resumeHighlights.slice(0, 2).map(b => `• ${b}`).join("\n")
        : "I have strong foundational experience matching the responsibilities required.";

      const structuredAnswers: ApplicationAnswers = {
        summary: parsed.summary,
        why_role: parsed.why_role,
        answers: {
          why_company: parsed.answers.why_company || "",
          strengths: strengthsTemplate,
          experience: experienceTemplate,
          custom: parsed.answers.custom || {}
        },
        confidence: 0 // Will compute below
      };

      // Validate
      const validationInput: Record<string, string> = {
        summary: structuredAnswers.summary,
        why_role: structuredAnswers.why_role,
        why_company: structuredAnswers.answers.why_company,
        strengths: structuredAnswers.answers.strengths,
        experience: structuredAnswers.answers.experience
      };

      // Existing validation + new structural/word-limit validation
      const validation = validateApplicationAnswers(validationInput, jobKeywords, ctx.resumeHighlights);
      if (!validation.valid) throw new Error(`Validation failed: ${validation.rejectionReason}`);

      const wlCheck = checkWordLimit(validationInput, 80);
      if (!wlCheck.valid) throw new Error(wlCheck.rejectionReason);

      const toneCheck = checkToneConsistency(validationInput);
      if (!toneCheck.valid) throw new Error(toneCheck.rejectionReason);

      const structuredWhyRoleCheck = checkStructuredWhyRole(structuredAnswers.why_role, jobKeywords);
      if (!structuredWhyRoleCheck.valid) throw new Error(structuredWhyRoleCheck.rejectionReason);

      // Compute confidence score based on keyword coverage and grounding
      const kwCoverage = jobKeywords.length > 0 
        ? ctx.matchedSkills.length / jobKeywords.length 
        : 1.0;
      const groundingStrength = ctx.resumeHighlights.length > 0 ? 1.0 : 0.4;
      structuredAnswers.confidence = Math.round((kwCoverage * 0.5 + groundingStrength * 0.5) * 100) / 100;

      // Save to cache
      responseCache.set(cacheKey, structuredAnswers);

      return structuredAnswers;

    } catch (err: any) {
      lastError = err.message;
      console.warn(`[ApplicationService] Attempt ${attempt} failed: ${lastError}`);
      if (attempt > maxRetries) {
        throw new Error(`Failed to generate valid application answers after ${maxRetries} attempts. Last error: ${lastError}`);
      }
    }
  }

  throw new Error("Application intelligence failed unexpectedly.");
}
