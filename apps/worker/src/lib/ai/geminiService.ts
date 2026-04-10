import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";

const JobInsightsSchema = z.object({
  keywords: z.array(z.string()).default([]),
  skillGaps: z.array(z.string()).default([]),
  relevanceScore: z.number().min(0).max(1).default(0.72)
});

const ResumeOptimizationSchema = z.object({
  scoreBefore: z.number().min(0).max(1).default(0.62),
  scoreAfter: z.number().min(0).max(1).default(0.84),
  selectedProjects: z.array(z.string()).default([]),
  tailoredBullets: z.array(z.string()).default([])
});

const FormAnswersSchema = z.object({
  answers: z.record(z.string()).default({}),
  checks: z.array(z.string()).default([])
});

export class GeminiService {
  private readonly modelName: string;
  private readonly client?: GoogleGenerativeAI;

  constructor() {
    this.modelName = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.client = new GoogleGenerativeAI(apiKey);
    }
  }

  async extractJobInsights(input: { targetRole?: string; jobUrl?: string }) {
    const fallback = {
      keywords: ["typescript", "playwright", "redis", "postgresql"],
      skillGaps: ["production observability", "adapter conformance tests"],
      relevanceScore: 0.78
    };

    const raw = await this.generateJson(
      `Extract top keywords and likely skill gaps from this target role and job source.\nRole: ${input.targetRole ?? "Unknown"}\nURL: ${input.jobUrl ?? "Unknown"}`,
      fallback
    );

    return JobInsightsSchema.parse(raw);
  }

  async optimizeResume(input: { targetRole?: string; keywords: string[]; resumeText?: string }) {
    const fallback = {
      scoreBefore: 0.63,
      scoreAfter: 0.86,
      selectedProjects: ["ATS Automation Engine", "Queue-Orchestrated Workflow Platform"],
      tailoredBullets: [
        "Built resilient queue-driven orchestration with retry-safe checkpoints.",
        "Shipped desktop automation with human-in-the-loop intervention for CAPTCHA and MFA."
      ]
    };

    const contextPart = input.resumeText
      ? `\n\nResume excerpt:\n${input.resumeText.slice(0, 2000)}`
      : "";

    const raw = await this.generateJson(
      `Create a concise resume optimization plan for role ${input.targetRole ?? "Unknown"}. Focus on these keywords: ${input.keywords.join(", ")}.${contextPart}`,
      fallback
    );

    return ResumeOptimizationSchema.parse(raw);
  }

  async generateFormAnswers(input: {
    targetRole?: string;
    keywords: string[];
    resumeText?: string;
    profile?: Record<string, string>;
  }) {
    const name = input.profile
      ? `${input.profile.firstName ?? ""} ${input.profile.lastName ?? ""}`.trim()
      : "Applicant";

    const fallback = {
      answers: {
        "why-this-company": `As ${name}, I'm drawn to this opportunity because it aligns with my background in building reliable, production-grade systems. I believe I can add immediate value while growing with the team.`,
        "years-experience": "5",
        "authorization-status": "Authorized to work in the United States",
        "salary-expectations": "Open to discussion based on the role and total compensation",
        "start-date": "Within 2 weeks",
        "cover-letter": `Dear Hiring Manager,\n\nI am excited to apply for the ${input.targetRole ?? "position"} role. With my background in ${input.keywords.slice(0, 3).join(", ")}, I am confident I can make a meaningful contribution to your team.\n\nBest regards,\n${name}`
      },
      checks: ["company-name-alignment", "timeline-consistency", "skill-claim-verification"]
    };

    const contextParts = [];
    if (input.resumeText) {
      contextParts.push(`Resume:\n${input.resumeText.slice(0, 2500)}`);
    }
    if (input.profile) {
      contextParts.push(`Applicant: ${name}, Location: ${input.profile.location ?? "N/A"}`);
    }

    const raw = await this.generateJson(
      `Generate ATS-safe, concise, first-person answers for common job application form questions.\nRole: ${input.targetRole ?? "Unknown"}\nKey skills: ${input.keywords.join(", ")}\n${contextParts.join("\n")}\n\nProvide realistic, specific answers. Include a brief cover letter under the key "cover-letter".`,
      fallback
    );

    return FormAnswersSchema.parse(raw);
  }

  private async generateJson<T extends Record<string, unknown>>(prompt: string, fallback: T): Promise<T> {
    if (!this.client) {
      return fallback;
    }

    try {
      const model = this.client.getGenerativeModel({ model: this.modelName });
      const response = await model.generateContent([
        "Return only valid JSON with no markdown fences or extra text.",
        prompt,
        `Expected JSON shape: ${JSON.stringify(fallback)}`
      ]);

      const text = response.response.text();
      return this.safeParseJson(text, fallback);
    } catch {
      return fallback;
    }
  }

  private safeParseJson<T extends Record<string, unknown>>(raw: string, fallback: T): T {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
    const candidate = fenced?.[1] ?? trimmed;

    try {
      const parsed = JSON.parse(candidate) as T;
      return parsed;
    } catch {
      return fallback;
    }
  }
}
