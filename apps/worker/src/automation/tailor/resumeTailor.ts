import { GoogleGenerativeAI } from "@google/generative-ai";
import { type TailorResumeInput, type ResumeCanonical } from "./types.js";
import { logger } from "../browser/logger.js";

const LLM_TIMEOUT_MS = 5000;
const MAX_TOTAL_INJECTIONS = 5;
const KNOWN_SKILLS: string[] = [
  "JavaScript",
  "TypeScript",
  "React",
  "Node.js",
  "Python",
  "Java",
  "C++",
  "SQL",
  "PostgreSQL",
  "MongoDB",
  "AWS",
  "Docker",
  "Kubernetes",
  "GraphQL",
  "Next.js",
  "Express",
  "Redis",
  "Playwright"
];

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), timeoutMs);
    })
  ]);
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#.\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeSkills(skills: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of skills) {
    const skill = raw.trim();
    if (!skill) continue;
    const key = normalizeToken(skill);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(skill);
  }
  return out;
}

function getPerSectionLimit(): number {
  const configured = Number(process.env.RESUME_MAX_PER_SECTION ?? "4");
  if (!Number.isFinite(configured) || configured <= 0) {
    return 4;
  }

  return Math.floor(configured);
}

function inferSkillsFromResumeText(baseResume: string): string[] {
  const lower = baseResume.toLowerCase();
  return KNOWN_SKILLS.filter((skill) => lower.includes(skill.toLowerCase()));
}

function rewriteBulletWithKeywords(bullet: string, keywords: string[]): string {
  const cleanBullet = bullet.trim();
  if (!cleanBullet) return "";
  const selectedKeywords = keywords
    .filter((entry) => entry.trim().length >= 3)
    .slice(0, 2);

  if (selectedKeywords.length === 0) return cleanBullet;

  const lower = cleanBullet.toLowerCase();
  const missingKeyword = selectedKeywords.find((kw) => !lower.includes(kw.toLowerCase()));
  if (!missingKeyword) return cleanBullet;

  // Keep meaning intact by only adding contextual suffixes instead of replacing claims.
  return `${cleanBullet}, aligned with ${missingKeyword} requirements`;
}

function toExperienceBlocks(baseResume: string): ResumeCanonical["experience"] {
  const lines = baseResume
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates = lines.slice(1, 18);
  const blocks: ResumeCanonical["experience"] = [];
  for (let i = 0; i < candidates.length; i += 3) {
    const chunk = candidates.slice(i, i + 3);
    if (chunk.length === 0) continue;
    const [titleLine, ...rest] = chunk;
    const bullets = rest.length > 0 ? rest : ["Delivered measurable outcomes through cross-functional execution."];
    blocks.push({
      title: titleLine,
      bullets: bullets.slice(0, 3)
    });
  }

  return blocks.slice(0, 5);
}

function extractOriginalSections(baseResume: string): Omit<ResumeCanonical, "rawText"> {
  const lines = baseResume
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const summary = lines[0] ?? "Candidate summary not available.";
  const lineExtractedSkills = lines
    .filter((line) => /skill|javascript|typescript|react|python|node|sql|aws|java|docker|kubernetes|graphql|postgres|mongodb/i.test(line))
    .slice(0, 10);
  const inferredSkills = inferSkillsFromResumeText(baseResume);
  const skills = dedupeSkills([...lineExtractedSkills, ...inferredSkills]).slice(0, 12);
  const experience = toExperienceBlocks(baseResume);

  return {
    summary,
    skills,
    experience,
    keywordsInjected: []
  };
}

export function buildResumeCanonical(structured: Omit<ResumeCanonical, "rawText">): string {
  const summary = structured.summary.trim();
  const skillsLine = structured.skills.join(", ");
  const experienceLines = structured.experience
    .flatMap((entry) => [entry.title, ...entry.bullets.map((bullet) => `- ${bullet}`)])
    .join("\n");

  return [
    summary,
    "",
    `Skills: ${skillsLine}`,
    "",
    "Experience:",
    experienceLines,
  ].join("\n").trim();
}

export function validateResumeCanonical(resumeCanonical: ResumeCanonical, allowedTerms?: string[]) {
  if (!resumeCanonical.summary.trim()) throw new Error("Empty summary section");
  if (resumeCanonical.skills.length === 0) throw new Error("Empty skills section");
  if (resumeCanonical.experience.length === 0) throw new Error("Empty experience section");
  
  const skillCount = new Set(resumeCanonical.skills.map(normalizeToken)).size;
  if (skillCount !== resumeCanonical.skills.length) {
    throw new Error("Duplicate skills detected");
  }

  if (allowedTerms && allowedTerms.length > 0) {
    const allowed = new Set(allowedTerms.map(normalizeToken));
    for (const injected of resumeCanonical.keywordsInjected) {
      if (!allowed.has(normalizeToken(injected))) {
        throw new Error(`Hallucinated skill detected: ${injected}`);
      }
    }
  }
}

function fallbackTailoredResume(input: TailorResumeInput): ResumeCanonical {
  const perSectionLimit = getPerSectionLimit();
  const original = extractOriginalSections(input.baseResume);
  const topSkills = dedupeSkills(input.jobProfile.skills.slice(0, 5));
  const injected = topSkills.filter((skill) => !original.skills.some((s) => normalizeToken(s) === normalizeToken(skill)));

  const rewrittenExperience = original.experience.map((entry) => ({
    title: entry.title,
    bullets: entry.bullets.map((bullet) => rewriteBulletWithKeywords(bullet, input.jobProfile.keywords)).slice(0, perSectionLimit)
  }));

  const fallbackExperience = rewrittenExperience.length > 0
    ? rewrittenExperience
    : [{
      title: "Professional Experience",
      bullets: ["Delivered production-ready software with cross-functional collaboration."]
    }];

  const fallbackSkillCandidates = topSkills.length > 0
    ? topSkills
    : dedupeSkills(input.jobProfile.keywords.filter((keyword) => keyword.trim().length >= 3).slice(0, 5));

  const fallbackSkills = dedupeSkills([
    ...fallbackSkillCandidates,
    ...original.skills
  ]);

  const structured = {
    summary: original.summary,
    skills: fallbackSkills.length > 0 ? fallbackSkills : ["Software Development"],
    experience: fallbackExperience,
    keywordsInjected: injected.slice(0, MAX_TOTAL_INJECTIONS)
  };

  return {
    ...structured,
    rawText: buildResumeCanonical(structured)
  };
}

export async function tailorResume(input: TailorResumeInput): Promise<ResumeCanonical> {
  const perSectionLimit = getPerSectionLimit();
  const fallback = fallbackTailoredResume(input);
  const original = extractOriginalSections(input.baseResume);
  const topSkills = dedupeSkills(input.jobProfile.skills.slice(0, 5));
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return fallback;
  }

  try {
    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash" });
    const prompt = [
      "Tailor a resume for a specific job.",
      "Do not fabricate experience, employers, dates, or claims.",
      "Only rephrase and reorder existing information.",
      "Rewrite each bullet semantically so it better aligns with JD language while preserving the original meaning.",
      "Return valid JSON only with schema:",
      '{"summary":"string","skills":["string"],"experience":[{"title":"string","bullets":["string"]}],"keywordsInjected":["string"]}',
      `Target role: ${input.jobProfile.role}`,
      `Target skills (prioritize top 5 only): ${topSkills.join(", ")}`,
      `ATS keywords: ${input.jobProfile.keywords.join(", ")}`,
      "Preserve original resume structure. Do not aggressively reorder entire sections.",
      `Base resume:\n${input.baseResume.slice(0, 9000)}`
    ].join("\n");

    const response = await withTimeout(model.generateContent(prompt), LLM_TIMEOUT_MS);
    const raw = response.response.text().trim();
    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as Partial<ResumeCanonical>;

    const candidateSkills = dedupeSkills((parsed.skills ?? []).filter(Boolean));
    const safeSkillsBase = candidateSkills.length > 0 ? candidateSkills.slice(0, 8) : (topSkills.length > 0 ? topSkills : original.skills);
    const safeSkills = dedupeSkills([...safeSkillsBase, ...topSkills]).slice(0, 12);
    const safeSummary = parsed.summary?.trim() || original.summary;

    const parsedExperience = Array.isArray(parsed.experience) ? parsed.experience : [];
    const safeExperience = parsedExperience
      .filter((entry) => !!entry && typeof entry === "object")
      .map((entry) => ({
        title: ((entry as { title?: string }).title ?? "Experience").toString().trim() || "Experience",
        bullets: (((entry as { bullets?: string[] }).bullets) ?? [])
          .map((bullet) => rewriteBulletWithKeywords(String(bullet), input.jobProfile.keywords))
          .filter((bullet) => bullet.trim().length > 0)
          .slice(0, perSectionLimit)
      }))
      .filter((entry) => entry.bullets.length > 0);

    const injectedFromModel = dedupeSkills((parsed.keywordsInjected ?? []).filter(Boolean));
    const injectedFromTopSkills = topSkills.filter((skill) => !safeSkills.some((s) => normalizeToken(s) === normalizeToken(skill)));
    const keywordsInjected = dedupeSkills([...injectedFromModel, ...injectedFromTopSkills]).slice(0, MAX_TOTAL_INJECTIONS);

    const structured = {
      summary: safeSummary,
      skills: dedupeSkills([...safeSkills, ...keywordsInjected]),
      experience: safeExperience.length > 0 ? safeExperience.slice(0, 8) : fallback.experience,
      keywordsInjected
    };

    const canonical: ResumeCanonical = {
      ...structured,
      rawText: buildResumeCanonical(structured)
    };
    
    validateResumeCanonical(canonical, input.jobProfile.keywords);
    return canonical;
  } catch {
    logger.warn("tailor.timeout", { stage: "resume_tailor" });
    return fallback;
  }
}

export function generatePDF(resumeCanonical: ResumeCanonical): string {
  const computed = buildResumeCanonical(resumeCanonical);
  if (computed !== resumeCanonical.rawText) {
    throw new Error("Canonical mismatch — blocking PDF generation");
  }
  return computed;
}
