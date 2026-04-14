import { GoogleGenerativeAI } from "@google/generative-ai";
import { type EnhanceAnswersInput } from "./types.js";
import { logger } from "../browser/logger.js";

const MAX_KEYWORDS_PER_ANSWER = 2;
const LLM_TIMEOUT_MS = 5000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), timeoutMs);
    })
  ]);
}

function normalizeWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

function selectRelevantKeywords(question: string, baseAnswer: string, keywords: string[]): string[] {
  const context = new Set([...normalizeWords(question), ...normalizeWords(baseAnswer)]);
  const relevant = keywords.filter((keyword) => {
    const parts = normalizeWords(keyword);
    return parts.some((part) => context.has(part));
  });
  return relevant.slice(0, MAX_KEYWORDS_PER_ANSWER);
}

function containsTooManyKeywords(answer: string, keywords: string[]): boolean {
  const lower = answer.toLowerCase();
  const hitCount = keywords.reduce((count, keyword) => {
    return count + (lower.includes(keyword.toLowerCase()) ? 1 : 0);
  }, 0);
  return hitCount > MAX_KEYWORDS_PER_ANSWER;
}

function fallbackEnhancement(input: EnhanceAnswersInput): Record<string, string> {
  const result: Record<string, string> = {};

  for (const question of input.questions) {
    const base = input.baseAnswers[question] ?? "";
    const relevantKeywords = selectRelevantKeywords(question, base, input.jobProfile.keywords);
    if (!base) {
      result[question] = "";
      continue;
    }

    if (relevantKeywords.length === 0) {
      result[question] = base;
      continue;
    }

    const keywordClause = ` Relevant focus: ${relevantKeywords.join(", ")}.`;
    result[question] = `${base}${keywordClause}`.slice(0, 320);
  }

  return result;
}

export async function enhanceAnswers(input: EnhanceAnswersInput): Promise<Record<string, string>> {
  const fallback = fallbackEnhancement(input);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return fallback;
  }

  try {
    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash" });
    const prompt = [
      "Enhance existing job application answers.",
      "Keep answers concise and clear.",
      "Do not fabricate data.",
      "Inject relevant job keywords and skills when appropriate.",
      "Return JSON object only where keys are exact question strings and values are improved answers.",
      `Role: ${input.jobProfile.role}`,
      `Skills: ${input.jobProfile.skills.join(", ")}`,
      `Keywords: ${input.jobProfile.keywords.join(", ")}`,
      `Questions: ${JSON.stringify(input.questions)}`,
      `Base answers: ${JSON.stringify(input.baseAnswers)}`
    ].join("\n");

    const response = await withTimeout(model.generateContent(prompt), LLM_TIMEOUT_MS);
    const raw = response.response.text().trim();
    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const enhanced: Record<string, string> = {};
    for (const question of input.questions) {
      const baseAnswer = input.baseAnswers[question] ?? "";
      const value = parsed[question];
      const relevantKeywords = selectRelevantKeywords(question, baseAnswer, input.jobProfile.keywords);

      if (!baseAnswer || baseAnswer.trim().length < 3) {
        enhanced[question] = baseAnswer;
        continue;
      }

      if (relevantKeywords.length === 0) {
        enhanced[question] = baseAnswer;
        continue;
      }

      if (typeof value === "string" && value.trim().length >= 3) {
        const candidate = value.trim();
        if (containsTooManyKeywords(candidate, input.jobProfile.keywords)) {
          enhanced[question] = baseAnswer;
        } else {
          enhanced[question] = candidate;
          logger.info("answer.enhanced", { question });
        }
      } else {
        enhanced[question] = baseAnswer;
      }
    }

    return Object.keys(enhanced).length > 0 ? enhanced : fallback;
  } catch {
    logger.warn("tailor.timeout", { stage: "answer_enhancer" });
    return fallback;
  }
}
