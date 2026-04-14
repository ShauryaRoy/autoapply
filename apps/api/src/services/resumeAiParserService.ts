import { GoogleGenerativeAI } from "@google/generative-ai";

export type ParsedResume = {
  header: {
    name: string;
    email: string;
    phone: string;
    links: string[];
  };
  education: {
    degree: string;
    institution: string;
    duration: string;
    details?: string[];
  }[];
  skills: {
    category?: string;
    items: string[];
  }[];
  experience: {
    role: string;
    company: string;
    duration: string;
    bullets: string[];
    tech?: string[];
  }[];
  projects: {
    title: string;
    bullets: string[];
    tech?: string[];
  }[];
  activities: {
    title: string;
    bullets: string[];
  }[];
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asString(item))
    .filter((item) => item.length > 0);
}

function mapObjectArray<T>(value: unknown, mapper: (entry: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) return [];

  const output: T[] = [];
  value.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    output.push(mapper(entry as Record<string, unknown>));
  });

  return output;
}

function normalizeParsedResume(raw: unknown): ParsedResume | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;

  const headerRaw = (input.header ?? {}) as Record<string, unknown>;

  const education = mapObjectArray(input.education, (value) => ({
    degree: asString(value.degree),
    institution: asString(value.institution),
    duration: asString(value.duration),
    details: asStringArray(value.details)
  }));

  const skills = mapObjectArray(input.skills, (value) => ({
    category: asString(value.category) || undefined,
    items: asStringArray(value.items)
  }));

  const experience = mapObjectArray(input.experience, (value) => ({
    role: asString(value.role),
    company: asString(value.company),
    duration: asString(value.duration),
    bullets: asStringArray(value.bullets),
    tech: asStringArray(value.tech)
  }));

  const projects = mapObjectArray(input.projects, (value) => ({
    title: asString(value.title),
    bullets: asStringArray(value.bullets),
    tech: asStringArray(value.tech)
  }));

  const activities = mapObjectArray(input.activities, (value) => ({
    title: asString(value.title),
    bullets: asStringArray(value.bullets)
  }));

  return {
    header: {
      name: asString(headerRaw.name),
      email: asString(headerRaw.email),
      phone: asString(headerRaw.phone),
      links: asStringArray(headerRaw.links)
    },
    education,
    skills,
    experience,
    projects,
    activities
  };
}

export async function parseResumeWithAI(
  text: string,
  params: {
    geminiApiKey: string;
    geminiModel?: string;
  }
): Promise<ParsedResume | null> {
  if (!text.trim()) return null;
  if (!params.geminiApiKey) return null;

  const model = new GoogleGenerativeAI(params.geminiApiKey).getGenerativeModel({
    model: params.geminiModel ?? process.env.GEMINI_MODEL ?? "gemini-2.0-flash"
  });

  const prompt = `You are a resume parser.

Convert the following resume text into STRICT JSON.

Rules:
- Do NOT hallucinate
- Do NOT merge unrelated sections
- Each job must be separate
- Each project must be separate
- "Tech:" must belong ONLY to the correct item
- Extract header only once
- Do NOT duplicate content
- Activities must not appear inside projects
- Output ONLY valid JSON (no explanation)

Resume:
${text}`;

  try {
    const result = await model.generateContent([prompt]);
    const rawResponse = result.response.text().trim();
    const cleaned = rawResponse
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned) as unknown;
    } catch {
      console.error("Invalid JSON from AI", cleaned);
      return null;
    }

    const normalized = normalizeParsedResume(parsed);
    if (!normalized || !Array.isArray(normalized.projects)) {
      return null;
    }

    return normalized;
  } catch {
    return null;
  }
}
