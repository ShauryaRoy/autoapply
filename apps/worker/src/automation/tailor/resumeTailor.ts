import { GoogleGenerativeAI } from "@google/generative-ai";
import { type TailorResumeInput, type ResumeCanonical, type ResumeSectionEntry } from "./types.js";
import { logger } from "../browser/logger.js";

const LLM_TIMEOUT_MS = 30000; // 30 seconds for LLM API
const MAX_TOTAL_INJECTIONS = 5;
const MAX_PER_SECTION = 4;
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

function extractRoleFromJobDescription(jobDescription: string): string {
  const roleMatch = jobDescription.match(/role\s*:\s*(.+)/i);
  if (roleMatch?.[1]) {
    return roleMatch[1].trim();
  }

  const firstLine = jobDescription.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine ?? "Target Role";
}

function inferSkillsFromResumeText(originalResume: string): string[] {
  const lower = originalResume.toLowerCase();
  return KNOWN_SKILLS.filter((skill) => lower.includes(skill.toLowerCase()));
}

function rewriteBulletWithKeywords(bullet: string, keywords: string[]): string {
  const cleanBullet = bullet.trim();
  if (!cleanBullet) return "";

  const selectedKeywords = keywords
    .map((keyword) => keyword.trim())
    .filter((entry) => entry.length >= 3)
    .slice(0, 2);

  if (selectedKeywords.length === 0) return cleanBullet;

  const lower = cleanBullet.toLowerCase();
  const missingKeyword = selectedKeywords.find((kw) => !lower.includes(kw.toLowerCase()));
  if (!missingKeyword) return cleanBullet;

  // Preserve claim fidelity while improving JD term alignment.
  return `${cleanBullet}, aligned with ${missingKeyword} requirements`;
}

// ── Section header detection ─────────────────────────────────────────────────

const SECTION_MAP: Record<string, string> = {
  "summary": "summary",
  "professional summary": "summary",
  "career summary": "summary",
  "profile": "summary",
  "about": "summary",
  "objective": "summary",
  "career objective": "summary",
  "experience": "experience",
  "work experience": "experience",
  "professional experience": "experience",
  "employment": "experience",
  "employment history": "experience",
  "work history": "experience",
  "career history": "experience",
  "projects": "projects",
  "project experience": "projects",
  "personal projects": "projects",
  "side projects": "projects",
  "skills": "skills",
  "technical skills": "skills",
  "core skills": "skills",
  "competencies": "skills",
  "core competencies": "skills",
  "technologies": "skills",
  "tech stack": "skills",
  "tools": "skills",
  "education": "education",
  "academic background": "education",
  "qualifications": "education",
  "activities": "activities",
  "volunteer": "activities",
  "volunteer experience": "activities",
  "extracurricular": "activities",
  "certifications": "activities",
  "awards": "activities",
  "achievements": "activities",
  "honors": "activities",
};

function isSectionHeader(line: string): string | null {
  const normalized = line
    .replace(/[:\-|/\\]+$/, "")
    .trim()
    .toLowerCase();
  // Must be relatively short to be a header, and not look like a bullet or sentence
  if (normalized.length > 60) return null;
  if (normalized.split(" ").length > 6) return null;
  if (normalized.endsWith(".")) return null;
  return SECTION_MAP[normalized] ?? null;
}

function isContactLine(line: string): boolean {
  return (
    /@/.test(line) ||
    /\+?\d[\d\s().–\-]{6,}/.test(line) ||
    /linkedin\.com|github\.com|portfolio/i.test(line) ||
    /^https?:\/\//i.test(line) ||
    /[a-z]{2,},\s+[a-z]{2,}/i.test(line) // city, state
  );
}

type ParsedSections = {
  header: string[];
  summary: string[];
  experience: string[];
  projects: string[];
  skills: string[];
  education: string[];
  activities: string[];
};

function parseResumeSections(originalResume: string): ParsedSections {
  const lines = originalResume.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sections: ParsedSections = {
    header: [],
    summary: [],
    experience: [],
    projects: [],
    skills: [],
    education: [],
    activities: [],
  };

  let currentSection: keyof ParsedSections = "header";
  // First 5 lines treated as header unless a section header is detected
  let headerDone = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const detectedSection = isSectionHeader(line);

    if (detectedSection && detectedSection in sections) {
      currentSection = detectedSection as keyof ParsedSections;
      headerDone = true;
      continue;
    }

    // If we're still in header and hit a non-contact line after 4 lines, auto-end header
    if (!headerDone && i >= 4 && !isContactLine(line)) {
      headerDone = true;
      currentSection = "summary";
    }

    sections[currentSection].push(line);
  }

  return sections;
}

function parseExperienceEntries(lines: string[]): ResumeCanonical["experience"] {
  const entries: ResumeCanonical["experience"] = [];
  let currentTitle = "";
  let currentBullets: string[] = [];

  const flush = () => {
    if (!currentTitle) return;
    entries.push({
      title: currentTitle,
      bullets: currentBullets.filter((b) => b.trim().length > 0).slice(0, 5),
    });
    currentTitle = "";
    currentBullets = [];
  };

  for (const line of lines) {
    const isBullet =
      /^[-•·*▪]/.test(line) ||
      /^[a-z]/i.test(line) && line.length > 40;
    const looksLikeTitle =
      !isBullet &&
      line.length > 3 &&
      line.length < 100 &&
      (
        /[A-Z]/.test(line[0] ?? "") ||
        /\d{4}/.test(line) ||
        /at\s+|,|\|/.test(line)
      );

    if (looksLikeTitle && !currentTitle) {
      currentTitle = line;
    } else if (looksLikeTitle && currentBullets.length === 0 && currentTitle) {
      // Could be a subtitle/company - append to title
      currentTitle = `${currentTitle} | ${line}`;
    } else if (looksLikeTitle && currentBullets.length > 0) {
      // New entry
      flush();
      currentTitle = line;
    } else {
      const cleaned = line.replace(/^[-•·*▪]\s*/, "").trim();
      if (cleaned.length > 5) {
        currentBullets.push(cleaned);
      }
    }
  }

  flush();
  return entries.slice(0, 8);
}

function extractSkillsFromSection(lines: string[]): string[] {
  const skills: string[] = [];
  for (const line of lines) {
    // Handle comma/pipe/semicolon separated skills on one line
    const parts = line
      .split(/[,|;•·]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1 && s.length < 40 && !isContactLine(s));
    skills.push(...parts);
  }
  return skills;
}

function extractOriginalSections(originalResume: string): Omit<ResumeCanonical, "rawText"> {
  const sections = parseResumeSections(originalResume);

  // Summary: prefer dedicated summary section, else first non-contact header line
  let summary = sections.summary.filter((l) => !isContactLine(l)).join(" ").trim();
  if (!summary) {
    // Try first 2 lines of experience as a last resort summary
    summary = (sections.experience[0] ?? "Experienced professional delivering impactful results across cross-functional teams.");
  }

  // Skills: parse from the skills section, then fall back to inferred
  const sectionSkills = extractSkillsFromSection(sections.skills);
  const inferredSkills = inferSkillsFromResumeText(originalResume);
  const skills = dedupeSkills([...sectionSkills, ...inferredSkills]).slice(0, 15);

  // Experience: parse properly from the experience section
  const experience =
    sections.experience.length > 0
      ? parseExperienceEntries(sections.experience)
      : [];

  // Projects
  const projects =
    sections.projects.length > 0
      ? parseExperienceEntries(sections.projects)
      : [];

  // Activities (certifications, volunteer, etc.)
  const activities =
    sections.activities.length > 0
      ? parseExperienceEntries(sections.activities)
      : [];

  const safeExperience =
    experience.length > 0
      ? experience
      : [{ title: "Professional Experience", bullets: ["Delivered measurable outcomes through cross-functional execution."] }];

  const safeSkills =
    skills.length > 0
      ? skills
      : inferredSkills.length > 0
        ? inferredSkills
        : ["Communication", "Problem Solving", "Collaboration"];

  const safeSummary = summary || "Experienced professional delivering high-quality results.";

  return {
    summary: safeSummary,
    skills: safeSkills,
    experience: safeExperience,
    projects,
    activities,
    keywordsInjected: [],
  };
}

function sanitizeSectionEntries(
  rawEntries: unknown,
  fallbackEntries: ResumeSectionEntry[],
  rewriteKeywords: string[],
  perSectionLimit: number,
  maxEntries: number
): ResumeSectionEntry[] {
  if (!Array.isArray(rawEntries)) {
    return fallbackEntries.slice(0, maxEntries);
  }

  const entries = rawEntries
    .filter((entry) => !!entry && typeof entry === "object")
    .map((entry) => {
      const title = ((entry as { title?: string }).title ?? "Section").toString().trim() || "Section";
      const bullets = (((entry as { bullets?: string[] }).bullets) ?? [])
        .map((bullet) => rewriteBulletWithKeywords(String(bullet), rewriteKeywords))
        .filter((bullet) => bullet.trim().length > 0)
        .slice(0, perSectionLimit);

      return {
        title,
        bullets
      } satisfies ResumeSectionEntry;
    })
    .filter((entry) => entry.bullets.length > 0);

  if (entries.length === 0) {
    return fallbackEntries.slice(0, maxEntries);
  }

  return entries.slice(0, maxEntries);
}

export function buildResumeCanonical(structured: Omit<ResumeCanonical, "rawText">): string {
  const lines: string[] = [];

  if (structured.summary.trim()) {
    lines.push("Summary:", structured.summary.trim(), "");
  }

  const skillsLine = structured.skills.join(", ").trim();
  if (skillsLine) {
    lines.push(`Skills: ${skillsLine}`, "");
  }

  const appendSection = (label: string, entries: ResumeSectionEntry[]) => {
    if (entries.length === 0) return;

    lines.push(`${label}:`);
    entries.forEach((entry) => {
      lines.push(entry.title);
      entry.bullets.forEach((bullet) => {
        lines.push(`- ${bullet}`);
      });
    });
    lines.push("");
  };

  appendSection("Experience", structured.experience);
  appendSection("Projects", structured.projects);
  appendSection("Activities", structured.activities);

  return lines.join("\n").trim();
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

export function isTailored(canonical: ResumeCanonical, jd: string): boolean {
  const lowerJd = jd.toLowerCase();
  return canonical.skills.some((skill) => lowerJd.includes(skill.toLowerCase()));
}

function fallbackTailoredResume(input: TailorResumeInput): ResumeCanonical {
  const perSectionLimit = getPerSectionLimit();
  const original = extractOriginalSections(input.originalResume);
  const role = extractRoleFromJobDescription(input.jobDescription);
  const requiredSkills = dedupeSkills(input.requiredSkills).slice(0, 8);
  const preferredSkills = dedupeSkills(input.preferredSkills).slice(0, 8);
  const prioritizedSkills = dedupeSkills([...requiredSkills, ...preferredSkills]).slice(0, 12);
  const rewriteKeywords = dedupeSkills([...requiredSkills, ...preferredSkills]).slice(0, 6);

  const injected = prioritizedSkills.filter((skill) => !original.skills.some((s) => normalizeToken(s) === normalizeToken(skill)));

  const rewrittenExperience = original.experience.map((entry) => ({
    title: entry.title,
    bullets: entry.bullets.map((bullet) => rewriteBulletWithKeywords(bullet, rewriteKeywords)).slice(0, perSectionLimit)
  }));

  const fallbackExperience = rewrittenExperience.length > 0
    ? rewrittenExperience
    : [{
      title: "Professional Experience",
      bullets: ["Delivered production-ready software with cross-functional collaboration."]
    }];

  const summary = original.summary.toLowerCase().includes(role.toLowerCase())
    ? original.summary
    : `${original.summary} Targeted for ${role}.`;

  const structured: Omit<ResumeCanonical, "rawText"> = {
    summary,
    skills: dedupeSkills([
      ...prioritizedSkills,
      ...original.skills
    ]).slice(0, 12),
    experience: fallbackExperience,
    projects: original.projects,
    activities: original.activities,
    keywordsInjected: injected.slice(0, MAX_TOTAL_INJECTIONS)
  };

  const canonical: ResumeCanonical = {
    ...structured,
    rawText: buildResumeCanonical(structured)
  };

  validateResumeCanonical(canonical, dedupeSkills([...requiredSkills, ...preferredSkills]));
  if (!isTailored(canonical, input.jobDescription)) {
    throw new Error("Canonical resume is not JD-optimized");
  }

  return canonical;
}

export async function tailorResume(input: TailorResumeInput): Promise<ResumeCanonical> {
  const perSectionLimit = getPerSectionLimit();
  const fallback = fallbackTailoredResume(input);
  const original = extractOriginalSections(input.originalResume);
  const requiredSkills = dedupeSkills(input.requiredSkills).slice(0, 8);
  const preferredSkills = dedupeSkills(input.preferredSkills).slice(0, 8);
  const role = extractRoleFromJobDescription(input.jobDescription);
  const jdTerms = dedupeSkills([...requiredSkills, ...preferredSkills]);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return fallback;
  }

  try {
    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash" });
    const prompt = [
      "Tailor a resume for a specific job description.",
      "Do not fabricate experience, employers, dates, or claims.",
      "Only rephrase and reorder existing information.",
      "Prioritize required skills over preferred skills.",
      "Inject only legitimate JD keywords and maintain truthful bullet intent.",
      "Return valid JSON only with schema:",
      '{"summary":"string","skills":["string"],"experience":[{"title":"string","bullets":["string"]}],"projects":[{"title":"string","bullets":["string"]}],"activities":[{"title":"string","bullets":["string"]}],"keywordsInjected":["string"]}',
      `Target role: ${role}`,
      `Required skills: ${requiredSkills.join(", ")}`,
      `Preferred skills: ${preferredSkills.join(", ")}`,
      `Job description:\n${input.jobDescription.slice(0, 9000)}`,
      `Original resume:\n${input.originalResume.slice(0, 9000)}`
    ].join("\n");

    const response = await withTimeout(model.generateContent(prompt), LLM_TIMEOUT_MS);
    const raw = response.response.text().trim();
    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as Partial<ResumeCanonical>;

    const candidateSkills = dedupeSkills((parsed.skills ?? []).filter(Boolean));
    const safeSkills = dedupeSkills([
      ...requiredSkills,
      ...candidateSkills,
      ...preferredSkills,
      ...original.skills
    ]).slice(0, 12);

    const safeSummary = parsed.summary?.trim() || fallback.summary;
    const rewriteKeywords = jdTerms.length > 0 ? jdTerms : fallback.skills;

    const safeExperience = sanitizeSectionEntries(
      parsed.experience,
      fallback.experience,
      rewriteKeywords,
      perSectionLimit,
      8
    );

    const safeProjects = sanitizeSectionEntries(
      parsed.projects,
      fallback.projects,
      rewriteKeywords,
      perSectionLimit,
      6
    );

    const safeActivities = sanitizeSectionEntries(
      parsed.activities,
      fallback.activities,
      rewriteKeywords,
      perSectionLimit,
      6
    );

    const injectedFromModel = dedupeSkills((parsed.keywordsInjected ?? []).filter(Boolean));
    const injectedFromRequired = requiredSkills.filter((skill) => !original.skills.some((s) => normalizeToken(s) === normalizeToken(skill)));
    const keywordsInjected = dedupeSkills([...injectedFromModel, ...injectedFromRequired]).slice(0, MAX_TOTAL_INJECTIONS);

    const structured: Omit<ResumeCanonical, "rawText"> = {
      summary: safeSummary,
      skills: dedupeSkills([...safeSkills, ...keywordsInjected]).slice(0, 12),
      experience: safeExperience,
      projects: safeProjects,
      activities: safeActivities,
      keywordsInjected
    };

    const canonical: ResumeCanonical = {
      ...structured,
      rawText: buildResumeCanonical(structured)
    };

    validateResumeCanonical(canonical, jdTerms);
    if (!isTailored(canonical, input.jobDescription)) {
      throw new Error("Canonical resume is not JD-optimized");
    }

    return canonical;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn("tailor.error", {
      stage: "resume_tailor",
      message: errorMsg,
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString()
    });
    // Return fallback resume on any LLM or parsing error
    return fallback;
  }
}

export function generatePDF(resumeCanonical: ResumeCanonical): string {
  const computed = buildResumeCanonical(resumeCanonical);
  if (computed !== resumeCanonical.rawText) {
    throw new Error("Canonical mismatch - blocking PDF generation");
  }
  return computed;
}
