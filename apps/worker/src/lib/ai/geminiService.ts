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
  coverLetter: z.string().default(""),
  whyThisCompany: z.string().default(""),
  yearsExperience: z.string().default(""),
  answers: z.record(z.string()).default({})
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
    jobDescription?: string;
    resumeText?: string;
    resumeCanonical?: {
      summary?: string;
      skills?: string[];
      experience?: Array<{ title: string; bullets: string[] }>;
      projects?: Array<{ title: string; bullets: string[] }>;
    } | null;
    profile?: Record<string, string>;
    keywords?: string[];
  }) {
    const name = input.profile
      ? `${input.profile.firstName ?? ""} ${input.profile.lastName ?? ""}`.trim()
      : "Applicant";

    const role = input.targetRole ?? "this role";

    const canonicalSkills = input.resumeCanonical?.skills?.join(", ") ?? "";
    const canonicalExperience = (input.resumeCanonical?.experience ?? [])
      .map((e) => `${e.title}: ${e.bullets.slice(0, 2).join("; ")}`)
      .join("\n");
    const canonicalProjects = (input.resumeCanonical?.projects ?? [])
      .map((p) => `${p.title}: ${p.bullets.slice(0, 2).join("; ")}`)
      .join("\n");
    const canonicalSummary = input.resumeCanonical?.summary ?? "";

    // Build a rich cover letter fallback from whatever context is available
    const fallbackCoverLetter = [
      `Dear Hiring Manager,`,
      ``,
      `I am writing to apply for the ${role} position.`,
      canonicalSummary
        ? canonicalSummary
        : `My background spans software engineering, production system delivery, and cross-functional collaboration.`,
      canonicalExperience
        ? `Key contributions from my experience:\n${(input.resumeCanonical?.experience ?? []).slice(0, 2).map((e) => `- ${e.title}: ${e.bullets[0] ?? ""}`).join("\n")}`
        : `I have consistently delivered high-quality results throughout my career.`,
      ``,
      `I am confident that my skills in ${canonicalSkills || (input.keywords ?? []).join(", ") || "engineering and problem-solving"} make me a strong fit for this role.`,
      ``,
      `I would welcome the opportunity to discuss how my background aligns with your team's goals.`,
      ``,
      `Best regards,`,
      name,
    ].join("\n");

    const fallback = {
      coverLetter: fallbackCoverLetter,
      whyThisCompany: `I am excited about the ${role} role because it aligns with my background in ${canonicalSkills || "engineering"} and my commitment to delivering measurable results.`,
      yearsExperience: input.profile?.yearsExperience ?? "3",
      answers: {
        "why-this-company": `The ${role} role aligns with my background and the kind of high-impact work I want to contribute to.`,
        "years-experience": input.profile?.yearsExperience ?? "3",
        "authorization-status": "Authorized to work in the United States",
        "salary-expectations": "Open to discussion based on the role and total compensation",
        "start-date": "Within 2 weeks",
      },
    };

    if (!this.client) {
      return fallback;
    }

    const sections: string[] = [
      `CANDIDATE NAME: ${name}`,
      `TARGET ROLE: ${role}`,
    ];

    if (input.jobDescription?.trim()) {
      sections.push(`JOB DESCRIPTION:\n${input.jobDescription.slice(0, 6000)}`);
    }

    if (canonicalSummary) {
      sections.push(`CANDIDATE SUMMARY: ${canonicalSummary}`);
    }

    if (canonicalSkills) {
      sections.push(`CANDIDATE SKILLS: ${canonicalSkills}`);
    }

    if (canonicalExperience) {
      sections.push(`CANDIDATE EXPERIENCE:\n${canonicalExperience}`);
    }

    if (canonicalProjects) {
      sections.push(`CANDIDATE PROJECTS:\n${canonicalProjects}`);
    }

    if (input.resumeText && !canonicalExperience) {
      sections.push(`RESUME TEXT:\n${input.resumeText.slice(0, 3000)}`);
    }

    if (input.profile?.location) {
      sections.push(`LOCATION: ${input.profile.location}`);
    }

    const prompt = [
      "You are a professional cover letter writer and job application assistant.",
      "Write a personalized, compelling cover letter and form answers based on the candidate's actual resume and the job description.",
      "",
      "IMPORTANT RULES:",
      "- The cover letter MUST reference specific details from BOTH the job description AND the candidate's resume.",
      "- Do NOT use placeholder phrases like 'your company' or 'this role' without specifics from the JD.",
      "- Extract the actual company name from the JD if present.",
      "- Reference actual skills, technologies, and experience from the candidate's background that match the JD.",
      "- The cover letter should be 3-4 paragraphs: opening, experience alignment, skill match, closing.",
      "- Write in first person, professional but warm tone.",
      "- All claims must be grounded in the candidate's actual resume — do NOT fabricate.",
      "",
      ...sections,
      "",
      `Return ONLY valid JSON matching this schema exactly:`,
      `{`,
      `  "coverLetter": "full 3-4 paragraph cover letter text with \\n for line breaks",`,
      `  "whyThisCompany": "1-2 sentence answer to why you want to join",`,
      `  "yearsExperience": "number as string",`,
      `  "answers": {`,
      `    "why-this-company": "short answer",`,
      `    "years-experience": "number",`,
      `    "authorization-status": "Authorized to work in the United States",`,
      `    "salary-expectations": "Open to discussion",`,
      `    "start-date": "Within 2 weeks"`,
      `  }`,
      `}`,
    ].join("\n");

    try {
      const model = this.client.getGenerativeModel({ model: this.modelName });
      const response = await model.generateContent([
        "Return only valid JSON. No markdown, no explanation.",
        prompt,
      ]);

      const text = response.response.text();
      const parsed = this.safeParseJson<typeof fallback>(text, fallback);
      return FormAnswersSchema.parse(parsed);
    } catch {
      return fallback;
    }
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
