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

const API_BASE_URL = window.desktopApi?.apiBaseUrl ?? "http://localhost:4000";

export const parsedResumeCache: Partial<Record<string, ParsedResume>> = {};
const parsedResumeInFlight: Partial<Record<string, Promise<ParsedResume | null>>> = {};

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_REGEX = /(?:\+?\d[\d\s().-]{7,}\d)/;
const LINK_REGEX = /(https?:\/\/\S+|linkedin\.com\/\S+|github\.com\/\S+)/gi;
const BULLET_PREFIX_REGEX = /^(?:[-*•]|\d+[.)])\s*/;

type FallbackSection = "header" | "education" | "skills" | "experience" | "projects" | "activities";

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitResumeLines(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .replace(/•/g, "\n• ")
    .split(/\n+/)
    .map((line) => normalizeLine(line))
    .filter(Boolean);
}

function parseSkillItems(line: string): string[] {
  return line
    .replace(/^skills?\s*:?/i, "")
    .replace(/^technical\s+skills?\s*:?/i, "")
    .split(/[|,/;]+/)
    .map((item) => normalizeLine(item))
    .filter((item) => item.length > 1);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  values.forEach((value) => {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    output.push(value);
  });

  return output;
}

function detectSection(line: string): { section: FallbackSection; inline: string } | null {
  const patterns: Array<{ section: FallbackSection; regex: RegExp }> = [
    { section: "education", regex: /^(education|academic(?:\s+background)?|qualifications?)\b\s*:?\s*(.*)$/i },
    { section: "skills", regex: /^(skills?|technical\s+skills?|technologies|tech\s*stack)\b\s*:?\s*(.*)$/i },
    { section: "experience", regex: /^(experience|work\s+experience|employment|professional\s+experience)\b\s*:?\s*(.*)$/i },
    { section: "projects", regex: /^(projects?|portfolio)\b\s*:?\s*(.*)$/i },
    { section: "activities", regex: /^(activities|extracurricular(?:\s+activities)?)\b\s*:?\s*(.*)$/i }
  ];

  for (const { section, regex } of patterns) {
    const match = line.match(regex);
    if (!match) continue;
    return { section, inline: normalizeLine(match[2] ?? "") };
  }

  return null;
}

function isBullet(line: string): boolean {
  return BULLET_PREFIX_REGEX.test(line);
}

function stripBullet(line: string): string {
  return normalizeLine(line.replace(BULLET_PREFIX_REGEX, ""));
}

function isUsableParsedResume(parsed: ParsedResume | null): parsed is ParsedResume {
  if (!parsed) return false;
  if (isParsedResumeEmpty(parsed)) return false;
  return parsed.experience.length > 0 || parsed.projects.length > 0;
}

function buildStructuredFallbackFromText(text: string): ParsedResume | null {
  const lines = splitResumeLines(text);
  if (lines.length === 0) return null;

  const headerLines: string[] = [];
  const resume: ParsedResume = {
    header: {
      name: "",
      email: "",
      phone: "",
      links: []
    },
    education: [],
    skills: [],
    experience: [],
    projects: [],
    activities: []
  };

  let section: FallbackSection = "header";
  let currentExperience: ParsedResume["experience"][number] | null = null;
  let currentProject: ParsedResume["projects"][number] | null = null;
  let currentActivity: ParsedResume["activities"][number] | null = null;

  const flushExperience = () => {
    if (!currentExperience) return;
    if (currentExperience.role || currentExperience.bullets.length > 0) {
      resume.experience.push({
        role: currentExperience.role || "Experience",
        company: currentExperience.company,
        duration: currentExperience.duration,
        bullets: currentExperience.bullets,
        tech: currentExperience.tech?.length ? currentExperience.tech : undefined
      });
    }
    currentExperience = null;
  };

  const flushProject = () => {
    if (!currentProject) return;
    if (currentProject.title || currentProject.bullets.length > 0) {
      resume.projects.push({
        title: currentProject.title || "Project",
        bullets: currentProject.bullets,
        tech: currentProject.tech?.length ? currentProject.tech : undefined
      });
    }
    currentProject = null;
  };

  const flushActivity = () => {
    if (!currentActivity) return;
    if (currentActivity.title || currentActivity.bullets.length > 0) {
      resume.activities.push({
        title: currentActivity.title || "Activity",
        bullets: currentActivity.bullets
      });
    }
    currentActivity = null;
  };

  const processLine = (activeSection: FallbackSection, line: string) => {
    if (activeSection === "header") {
      headerLines.push(line);
      return;
    }

    if (activeSection === "skills") {
      const items = parseSkillItems(line);
      if (items.length > 0) {
        resume.skills.push({ category: undefined, items: dedupe(items) });
      }
      return;
    }

    if (activeSection === "education") {
      if (isBullet(line) && resume.education.length > 0) {
        const detail = stripBullet(line);
        if (detail) {
          const latest = resume.education[resume.education.length - 1];
          latest.details = dedupe([...(latest.details ?? []), detail]);
        }
        return;
      }

      const entryLine = stripBullet(line);
      if (!entryLine) return;
      resume.education.push({
        degree: entryLine,
        institution: "",
        duration: "",
        details: []
      });
      return;
    }

    if (/^tech(?:nologies)?\s*:/i.test(line)) {
      const techItems = parseSkillItems(line.replace(/^tech(?:nologies)?\s*:/i, "Skills:"));
      if (activeSection === "experience" && currentExperience && techItems.length > 0) {
        currentExperience.tech = dedupe([...(currentExperience.tech ?? []), ...techItems]);
      }
      if (activeSection === "projects" && currentProject && techItems.length > 0) {
        currentProject.tech = dedupe([...(currentProject.tech ?? []), ...techItems]);
      }
      return;
    }

    if (activeSection === "experience") {
      if (isBullet(line)) {
        const bullet = stripBullet(line);
        if (!bullet) return;
        if (!currentExperience) {
          currentExperience = { role: "Experience", company: "", duration: "", bullets: [], tech: [] };
        }
        currentExperience.bullets.push(bullet);
        return;
      }

      flushExperience();
      const segments = line.split("|").map((segment) => normalizeLine(segment)).filter(Boolean);
      currentExperience = {
        role: segments[0] || line,
        company: segments[1] || "",
        duration: segments[2] || "",
        bullets: [],
        tech: []
      };
      return;
    }

    if (activeSection === "projects") {
      if (isBullet(line)) {
        const bullet = stripBullet(line);
        if (!bullet) return;
        if (!currentProject) {
          currentProject = { title: "Project", bullets: [], tech: [] };
        }
        currentProject.bullets.push(bullet);
        return;
      }

      flushProject();
      currentProject = { title: stripBullet(line) || "Project", bullets: [], tech: [] };
      return;
    }

    if (activeSection === "activities") {
      if (isBullet(line)) {
        const bullet = stripBullet(line);
        if (!bullet) return;
        if (!currentActivity) {
          currentActivity = { title: "Activity", bullets: [] };
        }
        currentActivity.bullets.push(bullet);
        return;
      }

      flushActivity();
      currentActivity = { title: stripBullet(line) || "Activity", bullets: [] };
    }
  };

  lines.forEach((line) => {
    const detected = detectSection(line);
    if (detected) {
      flushExperience();
      flushProject();
      flushActivity();
      section = detected.section;
      if (detected.inline) {
        processLine(section, detected.inline);
      }
      return;
    }

    processLine(section, line);
  });

  flushExperience();
  flushProject();
  flushActivity();

  const emailMatch = text.match(EMAIL_REGEX);
  const phoneMatch = text.match(PHONE_REGEX);
  const linkMatches = [...text.matchAll(LINK_REGEX)].map((match) => normalizeLine(match[0] ?? "")).filter(Boolean);

  resume.header = {
    name: headerLines[0] || "Resume",
    email: emailMatch ? normalizeLine(emailMatch[0]) : "",
    phone: phoneMatch ? normalizeLine(phoneMatch[0]) : "",
    links: dedupe(linkMatches)
  };

  if (resume.experience.length === 0 && resume.projects.length === 0) {
    const fallbackBullets = lines
      .filter((line) => !detectSection(line))
      .map((line) => stripBullet(line))
      .filter((line) => line.length >= 12)
      .slice(0, 5);

    resume.experience.push({
      role: "Professional Experience",
      company: "",
      duration: "",
      bullets: fallbackBullets.length > 0 ? fallbackBullets : ["Resume content available for structured rendering."],
      tech: []
    });
  }

  resume.skills = resume.skills
    .map((entry) => ({
      ...entry,
      items: dedupe(entry.items)
    }))
    .filter((entry) => entry.items.length > 0);

  return resume;
}

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

async function fetchParsedResume(text: string): Promise<ParsedResume | null> {
  try {
    const token = localStorage.getItem("autoapply_token");

    const response = await fetch(`${API_BASE_URL}/api/resume/parse-ai`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { parsedResume?: unknown };
    let rawParsedResume: unknown = payload.parsedResume;

    if (typeof rawParsedResume === "string") {
      try {
        rawParsedResume = JSON.parse(rawParsedResume);
      } catch {
        console.error("Invalid JSON from AI", rawParsedResume);
        return null;
      }
    }

    const parsed = normalizeParsedResume(rawParsedResume);

    if (!parsed || !parsed.projects) {
      return null;
    }

    return parsed;
  } catch (error) {
    console.error("AI parse request failed", error);
    return null;
  }
}

export async function parseResumeWithAI(text: string, jobId?: string): Promise<ParsedResume | null> {
  const cacheKey = jobId?.trim() || "";

  if (!cacheKey) {
    const parsed = await fetchParsedResume(text);
    if (isUsableParsedResume(parsed)) {
      return parsed;
    }

    return buildStructuredFallbackFromText(text);
  }

  if (parsedResumeCache[cacheKey]) {
    return parsedResumeCache[cacheKey];
  }

  if (parsedResumeInFlight[cacheKey]) {
    return parsedResumeInFlight[cacheKey];
  }

  parsedResumeInFlight[cacheKey] = (async () => {
    const parsedResume = await fetchParsedResume(text);

    if (isUsableParsedResume(parsedResume)) {
      parsedResumeCache[cacheKey] = parsedResume;
      return parsedResume;
    }

    const fallback = buildStructuredFallbackFromText(text);
    if (!isUsableParsedResume(fallback)) {
      return null;
    }

    parsedResumeCache[cacheKey] = fallback;
    return fallback;
  })().finally(() => {
    delete parsedResumeInFlight[cacheKey];
  });

  return parsedResumeInFlight[cacheKey];
}

export async function parseResumeWithAICache(jobId: string, text: string): Promise<ParsedResume | null> {
  return parseResumeWithAI(text, jobId);
}

export function invalidateParsedResumeCache(jobId: string): void {
  const cacheKey = jobId.trim() || "default";
  delete parsedResumeCache[cacheKey];
  delete parsedResumeInFlight[cacheKey];
}

export function fallbackToSimpleRender(): null {
  return null;
}

export function isParsedResumeEmpty(parsedResume: ParsedResume | null | undefined): boolean {
  if (!parsedResume) return true;

  const hasHeader = Boolean(
    parsedResume.header.name ||
    parsedResume.header.email ||
    parsedResume.header.phone ||
    parsedResume.header.links.length > 0
  );

  return !hasHeader &&
    parsedResume.education.length === 0 &&
    parsedResume.skills.length === 0 &&
    parsedResume.experience.length === 0 &&
    parsedResume.projects.length === 0 &&
    parsedResume.activities.length === 0;
}
