import { GoogleGenerativeAI } from "@google/generative-ai";
import { type AnalyzeJobInput, type JobProfile } from "./types.js";
import { logger } from "../browser/logger.js";

const LLM_TIMEOUT_MS = 5000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), timeoutMs);
    })
  ]);
}

function inferSeniority(text: string): JobProfile["seniority"] {
  const lower = text.toLowerCase();
  if (/intern|trainee/.test(lower)) return "intern";
  if (/junior|entry/.test(lower)) return "junior";
  if (/senior|lead|staff|principal/.test(lower)) return "senior";
  return "mid";
}

function buildFallback(jobDescription: string): JobProfile {
  const cleaned = jobDescription.replace(/\s+/g, " ").trim();
  const words = cleaned.toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 2);
  const unique = Array.from(new Set(words));
  const topKeywords = unique.slice(0, 12);
  const topSkills = unique
    .filter((w) => ["javascript", "typescript", "react", "node", "python", "sql", "aws", "docker", "playwright", "redis", "postgresql"].includes(w))
    .slice(0, 10);

  return {
    role: "Unknown Role",
    skills: topSkills,
    keywords: topKeywords,
    seniority: inferSeniority(jobDescription)
  };
}

export async function analyzeJob(input: AnalyzeJobInput): Promise<JobProfile> {
  if (!input.jobDescription || input.jobDescription.trim().length < 50) {
    logger.warn("job.invalid_description");
    return buildFallback(input.jobDescription ?? "");
  }

  const fallback = buildFallback(input.jobDescription);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return fallback;
  }

  try {
    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash" });
    const prompt = [
      "Extract a structured job profile from a job description.",
      "Return valid JSON only.",
      "Schema:",
      '{"role":"string","skills":["max 10"],"keywords":["max 15"],"seniority":"intern|junior|mid|senior"}',
      "Use concise ATS-relevant keywords.",
      `Job description:\n${input.jobDescription.slice(0, 9000)}`
    ].join("\n");

    const response = await withTimeout(model.generateContent(prompt), LLM_TIMEOUT_MS);
    const raw = response.response.text().trim();
    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as Partial<JobProfile>;

    return {
      role: parsed.role?.trim() || fallback.role,
      skills: (parsed.skills ?? []).filter(Boolean).slice(0, 10),
      keywords: (parsed.keywords ?? []).filter(Boolean).slice(0, 15),
      seniority: parsed.seniority ?? fallback.seniority
    };
  } catch {
    logger.warn("tailor.timeout", { stage: "job_analyzer" });
    return fallback;
  }
}
