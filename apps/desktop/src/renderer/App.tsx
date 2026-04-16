import { useEffect, useMemo, useState, useCallback, useRef, type ChangeEvent } from "react";
import {
  login,
  register,
  logout,
  getMe,
  getProfile,
  getStoredToken,
  getStoredProfile,
  putProfile,
  saveProfile,
  createApplication,
  getApplication,
  getLatestPreview,
  pauseApplication,
  resumeApplication,
  subscribeToApplication,
  sendOnboardingMessage,
  extractFullProfile,
  saveOnboardingProfile,
  getStoredOnboardingProfile,
  type UserProfile,
  type EducationEntry,
  type ExperienceEntry,
  type SkillEntry,
  type WorkAuthorization,
  type EeoProfile,
  type LinkProfile,
  type RolePreferences,
  type SalaryPreferences,
  type Availability,
  type WorkPreferences,
  type OnboardingMessage,
  type OnboardingResponse,
  type OnboardingProfile
} from "./api.js";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { DashboardLayout } from "./layouts/dashboard-layout.js";
import { DashboardSidebar } from "./features/dashboard/components/dashboard-sidebar.js";
import { MainDashboardScreen } from "./features/dashboard/main-dashboard-screen.js";
import "./styles.css";

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

type EventLog = {
  id: string;
  step: string;
  message: string;
  createdAt: string;
  payloadJson?: { screenshotPath?: string; [key: string]: unknown };
};

type AppData = {
  id: string;
  currentStep: string;
  status: string;
  jobUrl: string;
  targetRole: string;
  events: EventLog[];
};

type ResumeDiffLine = {
  type: "added" | "removed" | "unchanged";
  text: string;
  reason?: string;
};

type ResumeOptimizationSnapshot = {
  before: string;
  canonical: string;
  injectedSkills: string[];
  keywordCandidates: string[];
  tailoringTriggered: boolean;
  fallbackUsed: boolean;
  tailoringError?: string;
  threshold: number;
  scoreBefore?: number;
  scoreAfter?: number;
  version: number;
  generatedFor: string;
  generatedAt: string;
  skillMatchBefore?: number;
  skillMatchAfter?: number;
  keywordOverlapBefore?: number;
  keywordOverlapAfter?: number;
};

type AuthUser = { id: string; email: string; firstName: string; lastName: string };
type Screen = "auth" | "profile" | "profileView" | "apply";
type ProfileSectionKey = "resume" | "roles" | "education" | "experience" | "workAuth" | "availability" | "salary" | "workPreferences" | "eeo" | "skills" | "personal" | "links";

const ORDERED_STEPS = [
  "queued", "job_scraped", "job_analyzed", "resume_optimized",
  "answers_generated", "browser_started", "logged_in", "form_filled",
  "submitted", "completed"
];

const PROFILE_SECTIONS: Array<{ key: ProfileSectionKey; label: string }> = [
  { key: "resume", label: "Resume Upload" },
  { key: "roles", label: "Roles" },
  { key: "education", label: "Education" },
  { key: "experience", label: "Experience" },
  { key: "workAuth", label: "Work Authorization" },
  { key: "availability", label: "Availability" },
  { key: "salary", label: "Salary" },
  { key: "workPreferences", label: "Work Preferences" },
  { key: "eeo", label: "EEO" },
  { key: "skills", label: "Skills" },
  { key: "personal", label: "Personal" },
  { key: "links", label: "Links" }
];

const MONTH_OPTIONS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const RESUME_PDF_DATA_URL_KEY = "autoapply_resume_pdf_data_url";
const RESUME_PDF_NAME_KEY = "autoapply_resume_pdf_name";
const RESUME_OPTIMIZATION_SNAPSHOT_KEY = "autoapply_resume_optimization_snapshot";

type StoredResumePdf = {
  dataUrl: string;
  fileName: string;
};

type StoredResumeDiff = {
  snapshot: ResumeOptimizationSnapshot;
};

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

const EMPTY_ROLE_PREFS: RolePreferences = {
  desiredRoles: [],
  preferredLocations: [],
  employmentTypes: []
};

const EMPTY_EDUCATION: EducationEntry = {
  school: "",
  major: "",
  degree: "",
  gpa: "",
  startMonth: "",
  startYear: "",
  endMonth: "",
  endYear: ""
};

const EMPTY_EXPERIENCE: ExperienceEntry = {
  title: "",
  company: "",
  location: "",
  type: "",
  startMonth: "",
  startYear: "",
  endMonth: "",
  endYear: "",
  current: false,
  description: ""
};

const EMPTY_WORK_AUTH: WorkAuthorization = {
  usAuthorized: "",
  canadaAuthorized: "",
  ukAuthorized: "",
  needsVisaSponsorship: ""
};

const EMPTY_EEO: EeoProfile = {
  ethnicities: [],
  declineEthnicity: false,
  disability: "",
  veteran: "",
  lgbtq: "",
  gender: ""
};

const EMPTY_LINKS: LinkProfile = {
  linkedin: "",
  github: "",
  portfolio: "",
  other: ""
};

const EMPTY_SALARY: SalaryPreferences = {
  expected: "",
  currency: "USD",
  openToNegotiation: ""
};

const EMPTY_AVAILABILITY: Availability = {
  noticePeriod: "",
  earliestStartDate: "",
  currentlyEmployed: ""
};

const EMPTY_WORK_PREFS: WorkPreferences = {
  mode: "",
  willingToRelocate: "",
  travelPercent: "",
  inPersonPercent: ""
};

const EMPTY_PROFILE: UserProfile = {
  firstName: "", lastName: "", email: "", phone: "",
  location: "", resumeText: "", linkedIn: "", portfolio: "",
  yearsExperience: "", whyCompany: "",
  roles: EMPTY_ROLE_PREFS,
  education: [EMPTY_EDUCATION],
  experience: [EMPTY_EXPERIENCE],
  workAuth: EMPTY_WORK_AUTH,
  eeo: EMPTY_EEO,
  skills: [],
  personal: { dateOfBirth: "" },
  links: EMPTY_LINKS,
  salary: EMPTY_SALARY,
  availability: EMPTY_AVAILABILITY,
  workPreferences: EMPTY_WORK_PREFS,
  answers: {}
};

function profileComplete(p: UserProfile): boolean {
  const education = p.education?.[0] ?? EMPTY_EDUCATION;
  const experience = p.experience?.[0] ?? EMPTY_EXPERIENCE;
  const workAuth = p.workAuth ?? EMPTY_WORK_AUTH;
  return !!(
    p.firstName &&
    p.lastName &&
    p.email &&
    p.phone &&
    p.location &&
    p.roles?.desiredRoles.length &&
    education.school &&
    education.major &&
    education.degree &&
    experience.title &&
    experience.company &&
    workAuth.usAuthorized &&
    workAuth.canadaAuthorized &&
    workAuth.ukAuthorized &&
    workAuth.needsVisaSponsorship
  );
}

function isProfileEffectivelyEmpty(profile: UserProfile): boolean {
  const education = profile.education?.[0] ?? EMPTY_EDUCATION;
  const experience = profile.experience?.[0] ?? EMPTY_EXPERIENCE;
  const hasEducation = !!(education.school || education.major || education.degree);
  const hasExperience = !!(experience.title || experience.company || experience.description);
  const hasSkills = !!(profile.skills?.length);
  const hasResume = !!profile.resumeText?.trim();
  return !(hasEducation || hasExperience || hasSkills || hasResume);
}

function normalizeProfile(initial: UserProfile): UserProfile {
  const normalizedSkills: SkillEntry[] = Array.isArray(initial.skills)
    ? initial.skills.map((s) => {
      if (typeof s === "string") return { name: s, preferred: false };
      return { name: s.name, preferred: !!s.preferred };
    }).filter((s) => !!s.name)
    : [];

  const links = {
    ...EMPTY_LINKS,
    ...initial.links,
    linkedin: initial.links?.linkedin ?? initial.linkedIn ?? "",
    portfolio: initial.links?.portfolio ?? initial.portfolio ?? ""
  };

  return {
    ...EMPTY_PROFILE,
    ...initial,
    roles: {
      ...EMPTY_ROLE_PREFS,
      ...initial.roles
    },
    education: initial.education?.length ? initial.education : [EMPTY_EDUCATION],
    experience: initial.experience?.length ? initial.experience : [EMPTY_EXPERIENCE],
    workAuth: {
      ...EMPTY_WORK_AUTH,
      ...initial.workAuth
    },
    eeo: {
      ...EMPTY_EEO,
      ...initial.eeo
    },
    skills: normalizedSkills,
    personal: {
      dateOfBirth: initial.personal?.dateOfBirth ?? ""
    },
    links,
    linkedIn: links.linkedin,
    portfolio: links.portfolio,
    salary: {
      ...EMPTY_SALARY,
      ...initial.salary
    },
    availability: {
      ...EMPTY_AVAILABILITY,
      ...initial.availability
    },
    workPreferences: {
      ...EMPTY_WORK_PREFS,
      ...initial.workPreferences
    },
    answers: initial.answers ?? {}
  };
}

function parseCommaSeparated(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => !!value);
}

function monthNumberToName(month: number | null | undefined): string {
  if (!month || month < 1 || month > 12) return "";
  return MONTH_OPTIONS[month - 1] ?? "";
}

function normalizeExperienceType(type: string): string {
  const normalized = type.trim().toLowerCase();
  if (normalized.includes("intern")) return "internship";
  if (normalized.includes("full")) return "full-time";
  if (normalized.includes("part")) return "part-time";
  if (normalized.includes("contract")) return "contract";
  return normalized;
}

function trimString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function getStoredResumePdf(): StoredResumePdf | null {
  try {
    const dataUrl = localStorage.getItem(RESUME_PDF_DATA_URL_KEY);
    const fileName = localStorage.getItem(RESUME_PDF_NAME_KEY);
    if (!dataUrl || !fileName) return null;
    return { dataUrl, fileName };
  } catch {
    return null;
  }
}

function saveStoredResumePdf(fileName: string, dataUrl: string): void {
  try {
    localStorage.setItem(RESUME_PDF_DATA_URL_KEY, dataUrl);
    localStorage.setItem(RESUME_PDF_NAME_KEY, fileName);
  } catch {
    // Ignore localStorage write failures.
  }
}

function getStoredResumeDiff(): StoredResumeDiff | null {
  try {
    const raw = localStorage.getItem(RESUME_OPTIMIZATION_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ResumeOptimizationSnapshot;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.before !== "string" || typeof parsed.canonical !== "string") return null;
    return { snapshot: parsed };
  } catch {
    return null;
  }
}

function saveStoredResumeDiff(diff: ResumeOptimizationSnapshot): void {
  try {
    localStorage.setItem(RESUME_OPTIMIZATION_SNAPSHOT_KEY, JSON.stringify(diff));
  } catch {
    // Ignore localStorage write failures.
  }
}

function resolveAddedLineReason(line: string, snapshot: ResumeOptimizationSnapshot): string | undefined {
  const normalized = line.toLowerCase();
  if (!normalized.trim()) return undefined;

  const missingMatch = snapshot.injectedSkills.find((skill) => normalized.includes(skill.toLowerCase()));
  if (missingMatch) return "added (missing skill)";

  const keywordMatch = snapshot.keywordCandidates.find((keyword) => normalized.includes(keyword.toLowerCase()));
  if (keywordMatch) return "added (keyword match)";

  return "added (tailoring)";
}

function buildResumeLineDiff(beforeText: string, canonicalText: string, snapshot?: ResumeOptimizationSnapshot): ResumeDiffLine[] {
  const before = beforeText.split(/\r?\n/);
  const canonical = canonicalText.split(/\r?\n/);

  const n = before.length;
  const m = canonical.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (before[i] === canonical[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const lines: ResumeDiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (before[i] === canonical[j]) {
      lines.push({ type: "unchanged", text: before[i] });
      i += 1;
      j += 1;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: "removed", text: before[i] });
      i += 1;
    } else {
      lines.push({
        type: "added",
        text: canonical[j],
        reason: snapshot ? resolveAddedLineReason(canonical[j], snapshot) : undefined
      });
      j += 1;
    }
  }

  while (i < n) {
    lines.push({ type: "removed", text: before[i] });
    i += 1;
  }

  while (j < m) {
    lines.push({
      type: "added",
      text: canonical[j],
      reason: snapshot ? resolveAddedLineReason(canonical[j], snapshot) : undefined
    });
    j += 1;
  }

  return lines;
}

function extractResumeDiffFromEvents(events: EventLog[]): ResumeOptimizationSnapshot | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.step !== "resume_optimized") continue;
    const payload = event.payloadJson ?? {};
    const before = typeof payload.resumeBefore === "string" ? payload.resumeBefore : "";
    const canonical = typeof payload.resumeCanonical === "string" ? payload.resumeCanonical : "";
    if (!before || !canonical) continue;

    const rawInjected = payload.missingSkillsInjected;
    const injectedSkills = Array.isArray(rawInjected)
      ? rawInjected.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];

    const rawKeywords = payload.keywordCandidates;
    const keywordCandidates = Array.isArray(rawKeywords)
      ? rawKeywords.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];

    const tailoringError = typeof payload.tailoringError === "string"
      ? payload.tailoringError
      : typeof payload.error === "string"
        ? payload.error
        : undefined;
    const tailoringTriggered = Boolean(payload.tailoringTriggered);
    const fallbackUsed = Boolean(payload.fallbackUsed || tailoringError);
    const threshold = typeof payload.threshold === "number"
      ? payload.threshold
      : typeof payload.tailoringThreshold === "number"
        ? payload.tailoringThreshold
        : 70;

    const scoreBeforeRaw = typeof payload.scoreBefore === "number" ? payload.scoreBefore : undefined;
    const scoreAfterRaw = typeof payload.scoreAfter === "number" ? payload.scoreAfter : undefined;
    const scoreBefore = typeof scoreBeforeRaw === "number" ? (scoreBeforeRaw <= 1 ? Math.round(scoreBeforeRaw * 100) : Math.round(scoreBeforeRaw)) : undefined;
    const scoreAfter = typeof scoreAfterRaw === "number" ? (scoreAfterRaw <= 1 ? Math.round(scoreAfterRaw * 100) : Math.round(scoreAfterRaw)) : undefined;

    const skillMatchBefore = typeof payload.skillMatchBefore === "number" ? Math.round(payload.skillMatchBefore) : scoreBefore;
    const skillMatchAfter = typeof payload.skillMatchAfter === "number" ? Math.round(payload.skillMatchAfter) : scoreAfter;
    const keywordOverlapBefore = typeof payload.keywordOverlapBefore === "number" ? Math.round(payload.keywordOverlapBefore) : undefined;
    const keywordOverlapAfter = typeof payload.keywordOverlapAfter === "number" ? Math.round(payload.keywordOverlapAfter) : undefined;

    const version = typeof payload.version === "number"
      ? payload.version
      : typeof payload.resumeVersion === "number"
        ? payload.resumeVersion
        : 0;
    const generatedFor = typeof payload.generatedFor === "string" ? payload.generatedFor : "unknown";
    const generatedAt = typeof payload.generatedAt === "string" ? payload.generatedAt : new Date(event.createdAt).toISOString();

    return {
      before,
      canonical,
      injectedSkills,
      keywordCandidates,
      tailoringTriggered,
      fallbackUsed,
      tailoringError,
      threshold,
      scoreBefore,
      scoreAfter,
      version,
      generatedFor,
      generatedAt,
      skillMatchBefore,
      skillMatchAfter,
      keywordOverlapBefore,
      keywordOverlapAfter
    };
  }

  return null;
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Could not read uploaded PDF."));
      }
    };
    reader.onerror = () => reject(new Error("Could not read uploaded PDF."));
    reader.readAsDataURL(file);
  });
}

function isGarbage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (!normalized) return false;

  if (normalized.length > 80) return true;
  if (normalized.includes("@")) return true;
  if (/linkedin|github/i.test(normalized)) return true;
  if (/\+91/i.test(normalized)) return true;

  const digitsOnly = normalized.replace(/\D/g, "");
  return digitsOnly.length > 8;
}

function containsEducationKeyword(value: string): boolean {
  return /university|college|institute|school/i.test(value);
}

function isValidEmail(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(trimmed);
}

function isValidPhone(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const digitsOnly = value.replace(/\D/g, "");
  return digitsOnly.length >= 9 && digitsOnly.length <= 15;
}

function inferRolesFromExtractedData(
  currentRoles: RolePreferences | undefined,
  extracted: OnboardingProfile
): RolePreferences {
  const existing = {
    ...EMPTY_ROLE_PREFS,
    ...currentRoles
  };

  const roleSet = new Set(
    (existing.desiredRoles ?? [])
      .map((role) => role.trim())
      .filter((role) => !!role && isValidJobTitle(role))
  );

  for (const exp of extracted.experience ?? []) {
    const jobTitle = trimString(exp.job_title);
    if (jobTitle && isValidJobTitle(jobTitle)) {
      roleSet.add(jobTitle);
    }
  }

  return {
    ...existing,
    desiredRoles: [...roleSet].slice(0, 3)
  };
}

function extractEmail(text: string): string {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] ?? "";
}

function extractPhone(text: string): string {
  const match = text.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  return match?.[0] ?? "";
}

function extractLinksFromText(text: string): { linkedin: string; github: string; portfolio: string } {
  const urls = Array.from(text.matchAll(/https?:\/\/[^\s)]+/gi)).map((m) => m[0]);
  const linkedin = urls.find((url) => /linkedin\.com/i.test(url)) ?? "";
  const github = urls.find((url) => /github\.com/i.test(url)) ?? "";
  const portfolio = urls.find((url) => !/linkedin\.com|github\.com/i.test(url)) ?? "";
  return { linkedin, github, portfolio };
}

function extractSkillsFromText(text: string): string[] {
  const keywords = [
    "JavaScript", "TypeScript", "React", "Node.js", "Python", "Java", "C++", "SQL",
    "PostgreSQL", "MongoDB", "AWS", "Docker", "Kubernetes", "Git", "Next.js", "Express"
  ];
  const lowerText = text.toLowerCase();
  return keywords.filter((skill) => lowerText.includes(skill.toLowerCase()));
}

type ResumeSections = {
  education: string;
  experience: string;
  projects: string;
  skills: string;
};

function splitSections(text: string): ResumeSections {
  const sections: ResumeSections = {
    education: "",
    experience: "",
    projects: "",
    skills: ""
  };

  const lines = text.split(/\r?\n/);
  let currentSection: keyof ResumeSections | null = null;

  for (const rawLine of lines) {
    const headingCandidate = rawLine.replace(/^#+\s*/, "").trim();
    const normalizedHeading = headingCandidate
      .replace(/[^A-Za-z]/g, "")
      .toLowerCase();

    if (normalizedHeading === "education" || normalizedHeading === "experience" || normalizedHeading === "projects" || normalizedHeading === "skills") {
      currentSection = normalizedHeading;
      continue;
    }

    if (!currentSection) continue;
    sections[currentSection] += `${rawLine}\n`;
  }

  return {
    education: sections.education.trim(),
    experience: sections.experience.trim(),
    projects: sections.projects.trim(),
    skills: sections.skills.trim()
  };
}

function parseYearRange(line: string): { startYear: number | null; endYear: number | null; current: boolean } {
  const compact = line.replace(/\s+/g, " ").trim();
  const rangeMatch = compact.match(/((?:19|20)\d{2})\s*[–—-]\s*((?:19|20)\d{2}|present|current)/i);
  if (!rangeMatch) {
    return { startYear: null, endYear: null, current: false };
  }

  const startYear = Number(rangeMatch[1]);
  const endToken = rangeMatch[2];
  const current = /present|current/i.test(endToken);
  const endYear = current ? null : Number(endToken);

  return { startYear, endYear, current };
}

function inferInstitutionFromTail(value: string): { institution: string | null; field: string | null } {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return { institution: null, field: null };

  const explicitInstitution = normalized.match(/([A-Z][A-Za-z&.-]*(?:\s+[A-Z][A-Za-z&.-]*){0,8}\s+(?:University|College|Institute|School))/);
  if (explicitInstitution?.[1]) {
    const institution = explicitInstitution[1].trim();
    const field = normalized.replace(institution, "").replace(/^[,\s-]+/, "").trim() || null;
    return { institution, field };
  }

  const tailTokens = normalized.split(/\s+/);
  for (let take = Math.min(4, tailTokens.length); take >= 2; take -= 1) {
    const candidate = tailTokens.slice(-take).join(" ");
    if (/^[A-Z][A-Za-z&.-]*(?:\s+[A-Z][A-Za-z&.-]*)+$/.test(candidate) || /\b(?:IIT|NIT|VIT)\b/i.test(candidate)) {
      const field = tailTokens.slice(0, tailTokens.length - take).join(" ").trim() || null;
      return { institution: candidate.trim(), field };
    }
  }

  return { institution: null, field: normalized || null };
}

function parseEducation(section: string): OnboardingProfile["education"] {
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => !!line);

  const emptyEducation = [{ institution: null, field_of_study: null, degree: null, gpa: null, startMonth: null, startYear: null, endMonth: null, endYear: null }];
  if (!lines.length) return emptyEducation;

  const degreeRegex = /(Bachelor(?:'s)?(?:\s+of\s+[A-Za-z&.\- ]+)?|Master(?:'s)?(?:\s+of\s+[A-Za-z&.\- ]+)?|B\.?\s?Tech|M\.?\s?Tech|B\.?\s?E|MBA|B\.?\s?Sc|M\.?\s?Sc|Ph\.?\s?D)/i;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const degreeMatch = line.match(degreeRegex);
    if (!degreeMatch) continue;

    const degree = degreeMatch[1].replace(/\s+/g, " ").trim();
    const trailing = line
      .replace(degreeMatch[0], "")
      .replace(/^[,\s-–—:]+/, "")
      .replace(/\s+/g, " ")
      .trim();

    const { institution, field } = inferInstitutionFromTail(trailing);
    const years = i + 1 < lines.length ? parseYearRange(lines[i + 1]) : { startYear: null, endYear: null, current: false };

    return [{
      institution,
      field_of_study: field,
      degree,
      gpa: null,
      startMonth: null,
      startYear: years.startYear,
      endMonth: null,
      endYear: years.endYear
    }];
  }

  return emptyEducation;
}

function parseExperience(section: string): OnboardingProfile["experience"] {
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => !!line);

  const experiences: OnboardingProfile["experience"] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\s+/g, " ").trim();
    const lineMatch = line.match(/^([^–—-]+?)\s*[–—-]\s*(.+)$/);
    if (!lineMatch) continue;

    const company = lineMatch[1].trim();
    let roleSegment = lineMatch[2].trim();

    const locationMatch = roleSegment.match(/\b(Remote|Hybrid|On[- ]?site)\b\s*$/i);
    const location = locationMatch?.[1]
      ? locationMatch[1].replace(/on[- ]?site/i, "Onsite")
      : null;
    if (locationMatch) {
      roleSegment = roleSegment.slice(0, locationMatch.index).trim();
    }

    roleSegment = roleSegment.replace(/\((?:Virtual|Remote|Hybrid|On[- ]?site)\)/ig, "").trim();
    const jobTitle = roleSegment.replace(/\s+/g, " ").trim();

    const employmentType = /intern/i.test(jobTitle)
      ? "internship"
      : /full[\s-]?time/i.test(jobTitle)
        ? "full-time"
        : /part[\s-]?time/i.test(jobTitle)
          ? "part-time"
          : /contract/i.test(jobTitle)
            ? "contract"
            : null;

    const dateLine = i + 1 < lines.length ? lines[i + 1] : "";
    const years = parseYearRange(dateLine);

    experiences.push({
      job_title: jobTitle || null,
      company: company || null,
      location,
      employment_type: employmentType,
      startMonth: null,
      startYear: years.startYear,
      endMonth: null,
      endYear: years.endYear,
      current: years.current,
      description: null
    });
  }

  if (!experiences.length) {
    return [{
      job_title: null,
      company: null,
      location: null,
      employment_type: null,
      startMonth: null,
      startYear: null,
      endMonth: null,
      endYear: null,
      current: false,
      description: null
    }];
  }

  return experiences;
}

function extractLocalOnboardingProfile(resumeText: string): OnboardingProfile {
  const sections = splitSections(resumeText);
  const email = extractEmail(resumeText);
  const phone = extractPhone(resumeText);
  const links = extractLinksFromText(resumeText);
  return {
    education: parseEducation(sections.education),
    experience: parseExperience(sections.experience),
    workAuth: {},
    eeo: {},
    skills: extractSkillsFromText(sections.skills),
    personal: {
      email,
      phone,
      location: ""
    },
    links
  };
}

function isValidDegree(val: unknown): boolean {
  const value = trimString(val);
  if (!value || isGarbage(value)) return false;
  return /b\.?tech|m\.?tech|b\.?e|bachelor|master|mba|ph\.?d|bs|ms|associate/i.test(value);
}

function isValidInstitution(val: unknown): boolean {
  const value = trimString(val);
  if (!value || isGarbage(value)) return false;
  return containsEducationKeyword(value);
}

function isValidCompany(val: unknown): boolean {
  const value = trimString(val);
  if (!value || isGarbage(value)) return false;
  if (/university|college/i.test(value)) return false;
  return value.length > 1 && value.length < 80;
}

function isValidJobTitle(val: unknown): boolean {
  const value = trimString(val);
  if (!value) return false;
  if (isGarbage(value)) return false;
  return value.length > 2 && value.length <= 80;
}

function isValidYear(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  const num = Number(val);
  return !isNaN(num) && num > 1950 && num <= 2050;
}

function isValidEmploymentType(val: unknown): boolean {
  if (!val) return true;
  return ["internship", "full-time", "part-time", "contract"].includes(String(val).toLowerCase());
}

function sanitizeExtractedData(data: OnboardingProfile): OnboardingProfile {
  const sanitized: OnboardingProfile = JSON.parse(JSON.stringify(data));

  if (sanitized.education && Array.isArray(sanitized.education)) {
    sanitized.education = sanitized.education.map(edu => ({
      ...edu,
      degree: isValidDegree(edu.degree) ? edu.degree : null,
      institution: isValidInstitution(edu.institution) ? edu.institution : null,
      field_of_study: typeof edu.field_of_study === 'string' && edu.field_of_study.length < 80 ? edu.field_of_study : null,
      startYear: isValidYear(edu.startYear) ? edu.startYear : null,
      endYear: isValidYear(edu.endYear) ? edu.endYear : null
    }));
  }

  if (sanitized.experience && Array.isArray(sanitized.experience)) {
    sanitized.experience = sanitized.experience.map(exp => ({
      ...exp,
      job_title: isValidJobTitle(exp.job_title) ? exp.job_title : null,
      company: isValidCompany(exp.company) ? exp.company : null,
      employment_type: isValidEmploymentType(exp.employment_type) ? String(exp.employment_type).toLowerCase() : null,
      startYear: isValidYear(exp.startYear) ? exp.startYear : null,
      endYear: isValidYear(exp.endYear) ? exp.endYear : null,
      current: !!exp.current,
      location: !isGarbage(String(exp.location ?? "")) ? trimString(exp.location) : null,
      description: !isGarbage(String(exp.description ?? "")) ? trimString(exp.description) : null
    }));
  }

  sanitized.skills = Array.isArray(sanitized.skills)
    ? sanitized.skills
      .map((skill) => trimString(skill))
      .filter((skill): skill is string => !!skill && !isGarbage(skill))
    : [];

  sanitized.personal = {
    ...sanitized.personal,
    firstName: !isGarbage(String(sanitized.personal?.firstName ?? "")) ? trimString(sanitized.personal?.firstName) ?? undefined : undefined,
    lastName: !isGarbage(String(sanitized.personal?.lastName ?? "")) ? trimString(sanitized.personal?.lastName) ?? undefined : undefined,
    email: isValidEmail(sanitized.personal?.email) ? trimString(sanitized.personal?.email) ?? undefined : undefined,
    phone: isValidPhone(sanitized.personal?.phone) ? trimString(sanitized.personal?.phone) ?? "" : "",
    location: !isGarbage(String(sanitized.personal?.location ?? "")) ? trimString(sanitized.personal?.location) ?? "" : ""
  };

  sanitized.links = {
    linkedin: trimString(sanitized.links?.linkedin) ?? "",
    github: trimString(sanitized.links?.github) ?? "",
    portfolio: trimString(sanitized.links?.portfolio) ?? ""
  };

  return sanitized;
}

function pickValidString(
  primaryValue: unknown,
  fallbackValue: unknown,
  validator: (value: unknown) => boolean
): string | null {
  const primary = trimString(primaryValue);
  if (primary && validator(primary)) return primary;

  const fallback = trimString(fallbackValue);
  if (fallback && validator(fallback)) return fallback;

  return null;
}

function hasMeaningfulEducationOrExperience(extracted: OnboardingProfile): boolean {
  const education = extracted.education?.[0];
  const experience = extracted.experience?.[0];

  const hasEducation = !!(education?.institution || education?.degree || education?.field_of_study);
  const hasExperience = !!(experience?.job_title || experience?.company || experience?.description);

  return hasEducation || hasExperience;
}

function mergeExtractedProfiles(primaryRaw: OnboardingProfile, fallbackRaw: OnboardingProfile): OnboardingProfile {
  const primary = sanitizeExtractedData(primaryRaw);
  const fallback = sanitizeExtractedData(fallbackRaw);

  const primaryEducation = primary.education?.[0];
  const fallbackEducation = fallback.education?.[0];
  const mergedEducation = {
    institution: pickValidString(primaryEducation?.institution, fallbackEducation?.institution, isValidInstitution),
    field_of_study: pickValidString(primaryEducation?.field_of_study, fallbackEducation?.field_of_study, (value) => !isGarbage(String(value))),
    degree: pickValidString(primaryEducation?.degree, fallbackEducation?.degree, isValidDegree),
    gpa: primaryEducation?.gpa ?? fallbackEducation?.gpa ?? null,
    startMonth: primaryEducation?.startMonth ?? fallbackEducation?.startMonth ?? null,
    startYear: primaryEducation?.startYear ?? fallbackEducation?.startYear ?? null,
    endMonth: primaryEducation?.endMonth ?? fallbackEducation?.endMonth ?? null,
    endYear: primaryEducation?.endYear ?? fallbackEducation?.endYear ?? null
  };

  const primaryExperience = primary.experience?.[0];
  const fallbackExperience = fallback.experience?.[0];
  const mergedExperience = {
    job_title: pickValidString(primaryExperience?.job_title, fallbackExperience?.job_title, isValidJobTitle),
    company: pickValidString(primaryExperience?.company, fallbackExperience?.company, isValidCompany),
    location: pickValidString(primaryExperience?.location, fallbackExperience?.location, (value) => !isGarbage(String(value))),
    employment_type: pickValidString(primaryExperience?.employment_type, fallbackExperience?.employment_type, isValidEmploymentType),
    startMonth: primaryExperience?.startMonth ?? fallbackExperience?.startMonth ?? null,
    startYear: primaryExperience?.startYear ?? fallbackExperience?.startYear ?? null,
    endMonth: primaryExperience?.endMonth ?? fallbackExperience?.endMonth ?? null,
    endYear: primaryExperience?.endYear ?? fallbackExperience?.endYear ?? null,
    current: !!(primaryExperience?.current ?? fallbackExperience?.current),
    description: pickValidString(primaryExperience?.description, fallbackExperience?.description, (value) => !isGarbage(String(value)))
  };

  return {
    ...fallback,
    ...primary,
    education: [mergedEducation],
    experience: [mergedExperience],
    personal: {
      ...fallback.personal,
      ...primary.personal,
      email: pickValidString(primary.personal?.email, fallback.personal?.email, isValidEmail) ?? "",
      phone: pickValidString(primary.personal?.phone, fallback.personal?.phone, isValidPhone) ?? "",
      location: pickValidString(primary.personal?.location, fallback.personal?.location, (value) => !isGarbage(String(value))) ?? ""
    },
    links: {
      linkedin: trimString(primary.links?.linkedin) ?? trimString(fallback.links?.linkedin) ?? "",
      github: trimString(primary.links?.github) ?? trimString(fallback.links?.github) ?? "",
      portfolio: trimString(primary.links?.portfolio) ?? trimString(fallback.links?.portfolio) ?? ""
    },
    skills: (primary.skills?.length ? primary.skills : fallback.skills) ?? []
  };
}

async function extractResumePdfText(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items
      .map((item) => {
        const token = item as { str?: string; transform?: number[] };
        return {
          text: (token.str ?? "").trim(),
          y: token.transform?.[5] ?? 0,
          x: token.transform?.[4] ?? 0
        };
      })
      .filter((item) => item.text.length > 0)
      .sort((a, b) => {
        if (Math.abs(b.y - a.y) > 2) {
          return b.y - a.y;
        }
        return a.x - b.x;
      });

    const groupedLines: Array<{ y: number; parts: string[] }> = [];
    items.forEach((item) => {
      const existing = groupedLines.find((line) => Math.abs(line.y - item.y) <= 2);
      if (existing) {
        existing.parts.push(item.text);
        return;
      }

      groupedLines.push({ y: item.y, parts: [item.text] });
    });

    const reconstructedLines = groupedLines
      .sort((a, b) => b.y - a.y)
      .map((line) => line.parts.join(" ").replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0);

    pages.push(reconstructedLines.join("\n"));
  }

  return pages.join("\n").trim();
}

function applyExtractedOnboardingData(
  current: UserProfile,
  extractedData: OnboardingProfile,
  resumeText: string
): UserProfile {
  // Pass extracted data through the validation layer
  const extracted = sanitizeExtractedData(extractedData);

  const currentEducation = current.education?.[0] ?? EMPTY_EDUCATION;
  const currentExperience = current.experience?.[0] ?? EMPTY_EXPERIENCE;
  const currentLinks = current.links ?? EMPTY_LINKS;

  const extractedEducation = extracted.education?.[0];
  const extractedExperience = extracted.experience?.[0];

  const currentSchool = trimString(currentEducation.school);
  const currentMajor = trimString(currentEducation.major);
  const currentDegree = trimString(currentEducation.degree);
  const currentTitle = trimString(currentExperience.title);
  const currentCompany = trimString(currentExperience.company);
  const currentLocation = trimString(currentExperience.location);
  const currentDescription = trimString(currentExperience.description);

  const nextSchool = pickValidString(extractedEducation?.institution, currentSchool, isValidInstitution);
  const nextMajor = pickValidString(extractedEducation?.field_of_study, currentMajor, (value) => !isGarbage(String(value)));
  const nextDegree = pickValidString(extractedEducation?.degree, currentDegree, isValidDegree);
  const nextTitle = pickValidString(extractedExperience?.job_title, currentTitle, isValidJobTitle);
  const nextCompany = pickValidString(extractedExperience?.company, currentCompany, isValidCompany);
  const nextLocation = pickValidString(extractedExperience?.location, currentLocation, (value) => !isGarbage(String(value)));
  const nextDescription = pickValidString(extractedExperience?.description, currentDescription, (value) => !isGarbage(String(value)));

  const education: EducationEntry = extractedEducation
    ? {
      ...currentEducation,
      school: nextSchool ?? "",
      major: nextMajor ?? "",
      degree: nextDegree ?? "",
      gpa: extractedEducation.gpa != null ? String(extractedEducation.gpa) : currentEducation.gpa,
      startMonth: monthNumberToName(extractedEducation.startMonth) || currentEducation.startMonth,
      startYear: extractedEducation.startYear != null ? String(extractedEducation.startYear) : currentEducation.startYear,
      endMonth: monthNumberToName(extractedEducation.endMonth) || currentEducation.endMonth,
      endYear: extractedEducation.endYear != null ? String(extractedEducation.endYear) : currentEducation.endYear
    }
    : currentEducation;

  const experience: ExperienceEntry = extractedExperience
    ? {
      ...currentExperience,
      title: nextTitle ?? "",
      company: nextCompany ?? "",
      location: nextLocation ?? "",
      type: extractedExperience.employment_type ? normalizeExperienceType(extractedExperience.employment_type) : currentExperience.type,
      startMonth: monthNumberToName(extractedExperience.startMonth) || currentExperience.startMonth,
      startYear: extractedExperience.startYear != null ? String(extractedExperience.startYear) : currentExperience.startYear,
      endMonth: extractedExperience.current ? "" : monthNumberToName(extractedExperience.endMonth) || currentExperience.endMonth,
      endYear: extractedExperience.current ? "" : extractedExperience.endYear != null ? String(extractedExperience.endYear) : currentExperience.endYear,
      current: !!extractedExperience.current,
      description: nextDescription ?? ""
    }
    : currentExperience;

  const links: LinkProfile = {
    ...currentLinks,
    linkedin: extracted.links?.linkedin || currentLinks.linkedin,
    github: extracted.links?.github || currentLinks.github,
    portfolio: extracted.links?.portfolio || currentLinks.portfolio,
    other: currentLinks.other
  };

  const extractedSkills = Array.isArray(extracted.skills)
    ? extracted.skills
      .map((name) => name.trim())
      .filter((name) => !!name && !isGarbage(name))
      .map((name) => ({ name, preferred: false }))
    : [];

  const roles = inferRolesFromExtractedData(current.roles, extracted);

  const nextProfile: UserProfile = {
    ...current,
    firstName: trimString(extracted.personal?.firstName) ?? trimString(current.firstName) ?? "",
    lastName: trimString(extracted.personal?.lastName) ?? trimString(current.lastName) ?? "",
    email: pickValidString(extracted.personal?.email, current.email, isValidEmail) ?? current.email,
    phone: pickValidString(extracted.personal?.phone, current.phone, isValidPhone) ?? current.phone,
    location: pickValidString(extracted.personal?.location, current.location, (value) => !isGarbage(String(value))) ?? current.location,
    resumeText,
    roles,
    education: [education],
    experience: [experience],
    skills: extractedSkills.length ? extractedSkills : current.skills,
    links,
    linkedIn: links.linkedin,
    portfolio: links.portfolio,
    answers: buildProfileAnswers({
      ...current,
      roles,
      education: [education],
      experience: [experience],
      skills: extractedSkills.length ? extractedSkills : current.skills,
      links,
      linkedIn: links.linkedin,
      portfolio: links.portfolio,
      phone: pickValidString(extracted.personal?.phone, current.phone, isValidPhone) ?? current.phone,
      location: pickValidString(extracted.personal?.location, current.location, (value) => !isGarbage(String(value))) ?? current.location
    })
  };

  return nextProfile;
}

function isValidUrl(value: string): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function buildProfileAnswers(profile: UserProfile): Record<string, string> {
  const education = profile.education?.[0] ?? EMPTY_EDUCATION;
  const experience = profile.experience?.[0] ?? EMPTY_EXPERIENCE;
  const links = profile.links ?? EMPTY_LINKS;
  const auth = profile.workAuth ?? EMPTY_WORK_AUTH;
  const eeo = profile.eeo ?? EMPTY_EEO;
  const sal = profile.salary ?? EMPTY_SALARY;
  const avail = profile.availability ?? EMPTY_AVAILABILITY;
  const prefs = profile.workPreferences ?? EMPTY_WORK_PREFS;

  return {
    "desired-roles": (profile.roles?.desiredRoles ?? []).join(", "),
    "preferred-locations": (profile.roles?.preferredLocations ?? []).join(", "),
    "employment-types": (profile.roles?.employmentTypes ?? []).join(", "),
    "school-name": education.school,
    "major": education.major,
    "degree-type": education.degree,
    gpa: education.gpa,
    "education-start-month": education.startMonth,
    "education-start-year": education.startYear,
    "education-end-month": education.endMonth,
    "education-end-year": education.endYear,
    "position-title": experience.title,
    company: experience.company,
    "experience-location": experience.location,
    "experience-type": experience.type,
    "experience-start-month": experience.startMonth,
    "experience-start-year": experience.startYear,
    "experience-end-month": experience.current ? "Current" : experience.endMonth,
    "experience-end-year": experience.current ? "Current" : experience.endYear,
    "currently-work-here": String(experience.current),
    "experience-description": experience.description,
    "work-auth-us": auth.usAuthorized,
    "work-auth-canada": auth.canadaAuthorized,
    "work-auth-uk": auth.ukAuthorized,
    "work-auth-sponsorship": auth.needsVisaSponsorship,
    // Availability
    "notice-period": avail.noticePeriod ?? "",
    "earliest-start-date": avail.earliestStartDate ?? "",
    "currently-employed": avail.currentlyEmployed ?? "",
    // Salary
    "expected-salary": sal.expected ?? "",
    "salary-currency": sal.currency ?? "USD",
    "open-to-negotiation": sal.openToNegotiation ?? "",
    // Work preferences
    "work-mode": prefs.mode ?? "",
    "willing-to-relocate": prefs.willingToRelocate ?? "",
    "travel-percent": prefs.travelPercent ?? "",
    "in-person-percent": prefs.inPersonPercent ?? "",
    // EEO
    ethnicity: eeo.declineEthnicity ? "Decline to state" : eeo.ethnicities.join(", "),
    disability: eeo.disability,
    veteran: eeo.veteran,
    lgbtq: eeo.lgbtq,
    gender: eeo.gender,
    skills: (profile.skills ?? []).map((skill) => skill.name).join(", "),
    "preferred-skills": (profile.skills ?? []).filter((skill) => skill.preferred).map((skill) => skill.name).join(", "),
    phone: profile.phone,
    location: profile.location,
    "date-of-birth": profile.personal?.dateOfBirth ?? "",
    linkedin: links.linkedin,
    github: links.github,
    portfolio: links.portfolio,
    "other-link": links.other
  };
}

// ──────────────────────────────────────────────
// Auth Screen
// ──────────────────────────────────────────────

function AuthScreen({ onAuth }: { onAuth: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handle = async () => {
    setError("");
    setLoading(true);
    try {
      if (mode === "register") {
        await register({ email, password, firstName, lastName });
        onAuth({ id: "", email, firstName, lastName });
      } else {
        await login({ email, password });
        const me = await getMe();
        onAuth(me);
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message ?? "Something went wrong";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter") void handle(); };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="logo-icon">⚡</span>
          <h1>AutoApply</h1>
          <p>AI-powered job application engine</p>
        </div>

        <div className="auth-tabs">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign In</button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create Account</button>
        </div>

        {mode === "register" && (
          <div className="field-row">
            <div className="field">
              <label>First Name</label>
              <input value={firstName} onChange={e => setFirstName(e.target.value)} onKeyDown={onKey} placeholder="Jane" />
            </div>
            <div className="field">
              <label>Last Name</label>
              <input value={lastName} onChange={e => setLastName(e.target.value)} onKeyDown={onKey} placeholder="Doe" />
            </div>
          </div>
        )}

        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={onKey} placeholder="you@email.com" />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={onKey} placeholder="••••••••" />
        </div>

        {error && <div className="auth-error">{error}</div>}

        <button className="auth-btn" onClick={handle} disabled={loading}>
          {loading ? "Please wait…" : mode === "login" ? "Sign In →" : "Create Account →"}
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Profile Setup Screen
// ──────────────────────────────────────────────

function ProfileScreen({
  user,
  initial,
  onSave,
  onGoApply,
  onLogout
}: {
  user: AuthUser;
  initial: UserProfile;
  onSave: (p: UserProfile) => void | Promise<void>;
  onGoApply: () => void;
  onLogout: () => void;
}) {
  const [profile, setProfile] = useState<UserProfile>(() => normalizeProfile(initial));
  const [saved, setSaved] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [skillInput, setSkillInput] = useState("");
  const [sectionWarning, setSectionWarning] = useState("");
  const [resumeUploadStatus, setResumeUploadStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [resumeUploadMessage, setResumeUploadMessage] = useState("");
  const [uploadedResumePdf, setUploadedResumePdf] = useState<StoredResumePdf | null>(() => getStoredResumePdf());
  const storedResumeDiff = useMemo(() => getStoredResumeDiff()?.snapshot ?? null, [profile.resumeText]);
  const storedResumeDiffLines = useMemo(() => {
    if (!storedResumeDiff) return [];
    return buildResumeLineDiff(storedResumeDiff.before, storedResumeDiff.canonical, storedResumeDiff);
  }, [storedResumeDiff]);

  const set = (field: keyof UserProfile) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setSaved(false);
    setSectionWarning("");
    setProfile(prev => ({ ...prev, [field]: e.target.value }));
  };

  const setEducation = (index: number, field: keyof EducationEntry) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.value;
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => {
      const education = [...(prev.education ?? [EMPTY_EDUCATION])];
      education[index] = { ...(education[index] ?? EMPTY_EDUCATION), [field]: value };
      return { ...prev, education };
    });
  };

  const setExperience = (index: number, field: keyof ExperienceEntry) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = e.target.value;
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => {
      const experience = [...(prev.experience ?? [EMPTY_EXPERIENCE])];
      experience[index] = { ...(experience[index] ?? EMPTY_EXPERIENCE), [field]: value };
      return { ...prev, experience };
    });
  };

  const setExperienceCurrent = (index: number) => (e: ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => {
      const experience = [...(prev.experience ?? [EMPTY_EXPERIENCE])];
      const currentEntry = experience[index] ?? EMPTY_EXPERIENCE;
      experience[index] = {
        ...currentEntry,
        current: checked,
        endMonth: checked ? "" : currentEntry.endMonth,
        endYear: checked ? "" : currentEntry.endYear
      };
      return { ...prev, experience };
    });
  };

  const addEducationEntry = () => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => ({
      ...prev,
      education: [...(prev.education ?? [EMPTY_EDUCATION]), { ...EMPTY_EDUCATION }]
    }));
  };

  const deleteEducationEntry = (index: number) => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => {
      const entries = [...(prev.education ?? [EMPTY_EDUCATION])];
      if (entries.length <= 1) {
        return { ...prev, education: [{ ...EMPTY_EDUCATION }] };
      }
      entries.splice(index, 1);
      return { ...prev, education: entries };
    });
  };

  const addExperienceEntry = () => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => ({
      ...prev,
      experience: [...(prev.experience ?? [EMPTY_EXPERIENCE]), { ...EMPTY_EXPERIENCE }]
    }));
  };

  const deleteExperienceEntry = (index: number) => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => {
      const entries = [...(prev.experience ?? [EMPTY_EXPERIENCE])];
      if (entries.length <= 1) {
        return { ...prev, experience: [{ ...EMPTY_EXPERIENCE }] };
      }
      entries.splice(index, 1);
      return { ...prev, experience: entries };
    });
  };

  const setRoleList = (field: keyof RolePreferences) => (e: ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => ({
      ...prev,
      roles: {
        ...EMPTY_ROLE_PREFS,
        ...prev.roles,
        [field]: parseCommaSeparated(e.target.value)
      }
    }));
  };

  const setWorkAuth = (field: keyof WorkAuthorization) => (e: ChangeEvent<HTMLSelectElement>) => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => ({
      ...prev,
      workAuth: {
        ...EMPTY_WORK_AUTH,
        ...prev.workAuth,
        [field]: e.target.value as WorkAuthorization[typeof field]
      }
    }));
  };

  const setEeo = (field: keyof EeoProfile) => (e: ChangeEvent<HTMLSelectElement>) => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => ({
      ...prev,
      eeo: {
        ...EMPTY_EEO,
        ...prev.eeo,
        [field]: e.target.value as EeoProfile[typeof field]
      }
    }));
  };

  const toggleEthnicity = (ethnicity: string) => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => {
      const eeo = { ...EMPTY_EEO, ...prev.eeo };
      if (eeo.declineEthnicity) return prev;
      const selected = new Set(eeo.ethnicities);
      if (selected.has(ethnicity)) selected.delete(ethnicity);
      else selected.add(ethnicity);
      return { ...prev, eeo: { ...eeo, ethnicities: [...selected] } };
    });
  };

  const toggleDeclineEthnicity = (e: ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => ({
      ...prev,
      eeo: {
        ...EMPTY_EEO,
        ...prev.eeo,
        declineEthnicity: checked,
        ethnicities: checked ? [] : prev.eeo?.ethnicities ?? []
      }
    }));
  };

  const addSkill = () => {
    const next = skillInput.trim();
    if (!next) return;
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => {
      const existing = prev.skills ?? [];
      const hasSkill = existing.some((item) => item.name.toLowerCase() === next.toLowerCase());
      if (hasSkill) return prev;
      return { ...prev, skills: [...existing, { name: next, preferred: false }] };
    });
    setSkillInput("");
  };

  const removeSkill = (name: string) => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => ({
      ...prev,
      skills: (prev.skills ?? []).filter((item) => item.name !== name)
    }));
  };

  const togglePreferredSkill = (name: string) => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => ({
      ...prev,
      skills: (prev.skills ?? []).map((item) =>
        item.name === name ? { ...item, preferred: !item.preferred } : item
      )
    }));
  };

  const setLink = (field: keyof LinkProfile) => (e: ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => {
      const links = {
        ...EMPTY_LINKS,
        ...prev.links,
        [field]: e.target.value
      };
      return {
        ...prev,
        links,
        linkedIn: links.linkedin,
        portfolio: links.portfolio
      };
    });
  };

  const setSalary = (field: keyof SalaryPreferences) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => ({
      ...prev,
      salary: {
        ...EMPTY_SALARY,
        ...prev.salary,
        [field]: e.target.value as SalaryPreferences[typeof field]
      }
    }));
  };

  const setAvailability = (field: keyof Availability) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => ({
      ...prev,
      availability: {
        ...EMPTY_AVAILABILITY,
        ...prev.availability,
        [field]: e.target.value as Availability[typeof field]
      }
    }));
  };

  const setWorkPreferences = (field: keyof WorkPreferences) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setSaved(false);
    setSectionWarning("");
    setProfile((prev) => ({
      ...prev,
      workPreferences: {
        ...EMPTY_WORK_PREFS,
        ...prev.workPreferences,
        [field]: e.target.value as WorkPreferences[typeof field]
      }
    }));
  };

  const handleResumePdfUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isPdfMime = file.type === "application/pdf";
    const isPdfByName = file.name.toLowerCase().endsWith(".pdf");
    if (!isPdfMime && !isPdfByName) {
      setResumeUploadStatus("error");
      setResumeUploadMessage("Please upload a PDF file.");
      e.target.value = "";
      return;
    }

    setSaved(false);
    setSectionWarning("");
    setResumeUploadStatus("uploading");
    setResumeUploadMessage("Extracting text from your resume...");

    try {
      const uploadedDataUrl = await readFileAsDataUrl(file);
      saveStoredResumePdf(file.name, uploadedDataUrl);
      setUploadedResumePdf({ fileName: file.name, dataUrl: uploadedDataUrl });

      const resumeText = await extractResumePdfText(file);
      if (!resumeText) {
        throw new Error("No readable text found in this PDF.");
      }

      setResumeUploadMessage("Analyzing extracted data...");
      let extracted: OnboardingProfile;
      let usedLocalFallback = false;
      try {
        const apiExtracted = await extractFullProfile(resumeText);
        const localExtracted = extractLocalOnboardingProfile(resumeText);
        extracted = mergeExtractedProfiles(apiExtracted, localExtracted);
        usedLocalFallback = !hasMeaningfulEducationOrExperience(apiExtracted);
      } catch {
        extracted = extractLocalOnboardingProfile(resumeText);
        usedLocalFallback = true;
      }
      setProfile((prev) => {
        const nextProfile = applyExtractedOnboardingData(prev, extracted, resumeText);
        void onSave(nextProfile);
        return nextProfile;
      });
      setSaved(true);
      setResumeUploadStatus("success");
      setResumeUploadMessage(
        usedLocalFallback
          ? "Resume imported with local parsing. Available fields were pre-filled."
          : "Resume imported. Your form fields were pre-filled."
      );
      const rolesStep = PROFILE_SECTIONS.findIndex((section) => section.key === "roles");
      if (rolesStep >= 0) {
        setActiveStep(rolesStep);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not parse this PDF.";
      setResumeUploadStatus("error");
      setResumeUploadMessage(message);
    } finally {
      e.target.value = "";
    }
  };

  const getSectionWarnings = (section: ProfileSectionKey): string[] => {
    const education = profile.education?.length ? profile.education : [EMPTY_EDUCATION];
    const experience = profile.experience?.length ? profile.experience : [EMPTY_EXPERIENCE];
    const workAuth = profile.workAuth ?? EMPTY_WORK_AUTH;
    const links = profile.links ?? EMPTY_LINKS;

    if (section === "roles" && !(profile.roles?.desiredRoles.length)) {
      return ["Add at least one desired role."];
    }
    if (section === "education") {
      const missing: string[] = [];
      education.forEach((entry, idx) => {
        const entryMissing = [
          ["School Name", entry.school],
          ["Major", entry.major],
          ["Degree Type", entry.degree],
          ["Start Month", entry.startMonth],
          ["Start Year", entry.startYear],
          ["End Month", entry.endMonth],
          ["End Year", entry.endYear]
        ].filter((item) => !item[1]).map((item) => `Education ${idx + 1}: ${item[0]}`);
        missing.push(...entryMissing);
      });
      return missing.length ? [`Complete: ${missing.join(", ")}.`] : [];
    }
    if (section === "experience") {
      const missing: string[] = [];
      experience.forEach((entry, idx) => {
        const entryMissing = [
          ["Position Title", entry.title],
          ["Company", entry.company],
          ["Location", entry.location],
          ["Experience Type", entry.type],
          ["Start Month", entry.startMonth],
          ["Start Year", entry.startYear],
          ["Description", entry.description],
          ["End Month", entry.current ? "ok" : entry.endMonth],
          ["End Year", entry.current ? "ok" : entry.endYear]
        ].filter((item) => !item[1]).map((item) => `Experience ${idx + 1}: ${item[0]}`);
        missing.push(...entryMissing);
        if (entry.description && entry.description.trim().length < 40) {
          missing.push(`Experience ${idx + 1}: Description should be more detailed`);
        }
      });
      return missing.length ? [`Complete: ${missing.join(", ")}.`] : [];
    }
    if (section === "workAuth") {
      const missing = [
        ["US authorization", workAuth.usAuthorized],
        ["Canada authorization", workAuth.canadaAuthorized],
        ["UK authorization", workAuth.ukAuthorized],
        ["Visa sponsorship", workAuth.needsVisaSponsorship]
      ].filter((item) => !item[1]).map((item) => item[0]);
      return missing.length ? [`Answer required: ${missing.join(", ")}.`] : [];
    }
    if (section === "skills" && !(profile.skills?.length)) {
      return ["Add at least one skill."];
    }
    if (section === "personal") {
      const missing = [
        ["Current location", profile.location],
        ["Date of birth", profile.personal?.dateOfBirth],
        ["Phone number", profile.phone]
      ].filter((item) => !item[1]).map((item) => item[0]);
      return missing.length ? [`Complete: ${missing.join(", ")}.`] : [];
    }
    if (section === "links") {
      const invalid = [
        ["LinkedIn", links.linkedin],
        ["GitHub", links.github],
        ["Portfolio", links.portfolio],
        ["Other", links.other]
      ]
        .filter((item) => !!item[1] && !isValidUrl(item[1]))
        .map((item) => item[0]);
      return invalid.length ? [`Invalid URL format: ${invalid.join(", ")}.`] : [];
    }
    return [];
  };

  const handleSaveAndContinue = () => {
    const currentSection = PROFILE_SECTIONS[activeStep].key;
    const warnings = getSectionWarnings(currentSection);
    if (warnings.length > 0) {
      setSectionWarning(warnings[0]);
      return;
    }

    const nextProfile: UserProfile = {
      ...profile,
      linkedIn: profile.links?.linkedin ?? "",
      portfolio: profile.links?.portfolio ?? "",
      yearsExperience: String(profile.experience?.length ?? 0),
      answers: buildProfileAnswers(profile)
    };

    setSaved(true);
    setProfile(nextProfile);
    void onSave(nextProfile);

    if (activeStep === PROFILE_SECTIONS.length - 1) {
      return;
    }

    setActiveStep((prev) => prev + 1);
  };

  const education = profile.education?.length ? profile.education : [EMPTY_EDUCATION];
  const experience = profile.experience?.length ? profile.experience : [EMPTY_EXPERIENCE];
  const workAuth = profile.workAuth ?? EMPTY_WORK_AUTH;
  const eeo = profile.eeo ?? EMPTY_EEO;
  const links = profile.links ?? EMPTY_LINKS;
  const activeSection = PROFILE_SECTIONS[activeStep].key;

  return (
    <DashboardLayout
      sidebar={
        <DashboardSidebar
          userName={`${user.firstName} ${user.lastName}`}
          userEmail={user.email}
          activeItem="Profile"
          onNavigateApply={onGoApply}
          onNavigateJobs={onGoApply}
          onNavigateProfile={() => setActiveStep(0)}
          onNavigateSettings={onGoApply}
          onLogout={onLogout}
        />
      }
      leftRail={
        <aside className="left-panel" style={{ borderRight: "none" }}>
          <div className="panel-header">
            <span className="logo-icon-sm">🧩</span>
            <div>
              <h2>Your Profile</h2>
              <p className="user-email">{user.email}</p>
            </div>
          </div>
          <p className="panel-hint">
            Fill profile details section by section. Each Save and Continue moves to the next section on this same page.
          </p>
        </aside>
      }
      main={
        <div className="profile-main">
          <div className="profile-section-strip">
            {PROFILE_SECTIONS.map((section, idx) => (
              <button
                key={section.key}
                className={`profile-section-tab ${idx === activeStep ? "active" : ""}`}
                onClick={() => setActiveStep(idx)}
                type="button"
              >
                <span className="profile-section-index">{idx + 1}</span>
                <span>{section.label}</span>
              </button>
            ))}
          </div>

        {activeSection === "resume" && (
          <div className="profile-card">
            <h2>Resume Upload</h2>
            <p className="section-hint">Upload your resume PDF and we will auto-fill the sections below.</p>

            <div className="resume-upload-card">
              <label htmlFor="resume-pdf-input" className="resume-upload-label">Upload Resume PDF</label>
              <input
                id="resume-pdf-input"
                type="file"
                accept="application/pdf"
                onChange={handleResumePdfUpload}
                disabled={resumeUploadStatus === "uploading"}
              />
              <small className="mini-hint">
                We extract details from the PDF and pre-fill roles, education, experience, skills, personal info, and links.
              </small>

              {resumeUploadStatus === "uploading" && <p className="resume-upload-status">{resumeUploadMessage}</p>}
              {resumeUploadStatus === "success" && <p className="resume-upload-status success">{resumeUploadMessage}</p>}
              {resumeUploadStatus === "error" && <p className="resume-upload-status error">{resumeUploadMessage}</p>}
            </div>

            <div className="field" style={{ marginTop: 14 }}>
              <label>Uploaded Resume (PDF)</label>
              {uploadedResumePdf ? (
                <>
                  <button
                    type="button"
                    className="save-btn"
                    onClick={() => window.open(uploadedResumePdf.dataUrl, "_blank", "noopener,noreferrer")}
                  >
                    Resume PDF uploaded: {uploadedResumePdf.fileName}
                  </button>
                  <small className="mini-hint">Click to open your uploaded resume PDF.</small>
                </>
              ) : (
                <small className="mini-hint">No PDF resume uploaded yet.</small>
              )}
            </div>

            <div className="field" style={{ marginTop: 14 }}>
              <label>Optimized Resume Changes</label>
              {storedResumeDiff ? (
                <>
                  {storedResumeDiff.injectedSkills.length > 0 && (
                    <small className="mini-hint">Injected missing skills: {storedResumeDiff.injectedSkills.join(", ")}</small>
                  )}
                  <div className="resume-diff-view" style={{ maxHeight: 260, marginTop: 8 }}>
                    {storedResumeDiffLines.map((line, index) => (
                      <div key={`profile-diff-${line.type}-${index}`} className={`resume-diff-line ${line.type}`}>
                        <span className="resume-diff-prefix">{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}</span>
                        <span>{line.text || " "}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <small className="mini-hint">No optimization diff yet. Run an application to see resume changes.</small>
              )}
            </div>
          </div>
        )}

        {activeSection === "roles" && (
          <div className="profile-card">
            <h2>Roles</h2>
            <p className="section-hint">Desired job roles and work preferences</p>
            <div className="field">
              <label>Desired Job Roles *</label>
              <input
                value={(profile.roles?.desiredRoles ?? []).join(", ")}
                onChange={setRoleList("desiredRoles")}
                placeholder="Software Engineer, Frontend Engineer"
              />
              <small className="mini-hint">Comma separated</small>
            </div>
            <div className="field">
              <label>Preferred Locations</label>
              <input
                value={(profile.roles?.preferredLocations ?? []).join(", ")}
                onChange={setRoleList("preferredLocations")}
                placeholder="Remote, New York, Toronto"
              />
            </div>
            <div className="field">
              <label>Employment Types</label>
              <input
                value={(profile.roles?.employmentTypes ?? []).join(", ")}
                onChange={setRoleList("employmentTypes")}
                placeholder="Full-time, Internship, Contract"
              />
            </div>
          </div>
        )}

        {activeSection === "education" && (
          <div className="profile-card">
            <h2>Education</h2>
            <p className="section-hint">Used to autofill education sections in job applications</p>
            {education.map((entry, idx) => (
              <div key={`education-${idx}`} style={{ marginBottom: 20, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <strong>Education {idx + 1}</strong>
                  <button
                    type="button"
                    className="edit-profile-btn"
                    onClick={() => deleteEducationEntry(idx)}
                    disabled={education.length === 1}
                  >
                    Delete
                  </button>
                </div>
                <div className="field-grid">
                  <div className="field">
                    <label>School Name *</label>
                    <input value={entry.school} onChange={setEducation(idx, "school")} placeholder="University Name" />
                  </div>
                  <div className="field">
                    <label>Major *</label>
                    <input value={entry.major} onChange={setEducation(idx, "major")} placeholder="Computer Science" />
                  </div>
                  <div className="field">
                    <label>Degree Type *</label>
                    <input value={entry.degree} onChange={setEducation(idx, "degree")} placeholder="Bachelor's" />
                  </div>
                  <div className="field">
                    <label>GPA</label>
                    <input value={entry.gpa} onChange={setEducation(idx, "gpa")} placeholder="3.8" />
                  </div>
                  <div className="field">
                    <label>Start Month *</label>
                    <select value={entry.startMonth} onChange={setEducation(idx, "startMonth")}>
                      <option value="">Select month</option>
                      {MONTH_OPTIONS.map((month) => <option key={month} value={month}>{month}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Start Year *</label>
                    <input value={entry.startYear} onChange={setEducation(idx, "startYear")} placeholder="2020" />
                  </div>
                  <div className="field">
                    <label>End Month *</label>
                    <select value={entry.endMonth} onChange={setEducation(idx, "endMonth")}>
                      <option value="">Select month</option>
                      {MONTH_OPTIONS.map((month) => <option key={month} value={month}>{month}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>End Year *</label>
                    <input value={entry.endYear} onChange={setEducation(idx, "endYear")} placeholder="2024" />
                  </div>
                </div>
              </div>
            ))}
            <button type="button" className="save-btn" onClick={addEducationEntry}>+ Add Education</button>
          </div>
        )}

        {activeSection === "experience" && (
          <div className="profile-card">
            <h2>Experience</h2>
            <p className="section-hint">Primary experience to use when filling applications</p>
            {experience.map((entry, idx) => (
              <div key={`experience-${idx}`} style={{ marginBottom: 20, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <strong>Experience {idx + 1}</strong>
                  <button
                    type="button"
                    className="edit-profile-btn"
                    onClick={() => deleteExperienceEntry(idx)}
                    disabled={experience.length === 1}
                  >
                    Delete
                  </button>
                </div>
                <div className="field-grid">
                  <div className="field">
                    <label>Position Title *</label>
                    <input value={entry.title} onChange={setExperience(idx, "title")} placeholder="Software Engineer" />
                  </div>
                  <div className="field">
                    <label>Company *</label>
                    <input value={entry.company} onChange={setExperience(idx, "company")} placeholder="Company Inc." />
                  </div>
                  <div className="field">
                    <label>Location *</label>
                    <input value={entry.location} onChange={setExperience(idx, "location")} placeholder="San Francisco, CA" />
                  </div>
                  <div className="field">
                    <label>Experience Type *</label>
                    <select value={entry.type} onChange={setExperience(idx, "type")}>
                      <option value="">Select type</option>
                      <option value="internship">Internship</option>
                      <option value="full-time">Full-time</option>
                      <option value="part-time">Part-time</option>
                      <option value="contract">Contract</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Start Month *</label>
                    <select value={entry.startMonth} onChange={setExperience(idx, "startMonth")}>
                      <option value="">Select month</option>
                      {MONTH_OPTIONS.map((month) => <option key={month} value={month}>{month}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Start Year *</label>
                    <input value={entry.startYear} onChange={setExperience(idx, "startYear")} placeholder="2022" />
                  </div>
                  <div className="field">
                    <label>End Month {entry.current ? "" : "*"}</label>
                    <select value={entry.endMonth} onChange={setExperience(idx, "endMonth")} disabled={entry.current}>
                      <option value="">Select month</option>
                      {MONTH_OPTIONS.map((month) => <option key={month} value={month}>{month}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>End Year {entry.current ? "" : "*"}</label>
                    <input
                      value={entry.endYear}
                      onChange={setExperience(idx, "endYear")}
                      placeholder="2025"
                      disabled={entry.current}
                    />
                  </div>
                </div>

                <label className="checkbox-row">
                  <input type="checkbox" checked={entry.current} onChange={setExperienceCurrent(idx)} />
                  I currently work here
                </label>

                <div className="field">
                  <label>Description (what you did) *</label>
                  <textarea
                    value={entry.description}
                    onChange={setExperience(idx, "description")}
                    rows={5}
                    placeholder="Built and maintained user-facing features..."
                  />
                </div>
              </div>
            ))}
            <button type="button" className="save-btn" onClick={addExperienceEntry}>+ Add Experience</button>
          </div>
        )}

        {activeSection === "workAuth" && (
          <div className="profile-card">
            <h2>Work Authorization</h2>
            <p className="section-hint">Required for country-specific eligibility checks</p>
            <div className="field-grid">
              <div className="field">
                <label>Authorized to work in the US? *</label>
                <select value={workAuth.usAuthorized} onChange={setWorkAuth("usAuthorized")}>
                  <option value="">Select</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
              <div className="field">
                <label>Authorized to work in Canada? *</label>
                <select value={workAuth.canadaAuthorized} onChange={setWorkAuth("canadaAuthorized")}>
                  <option value="">Select</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
              <div className="field">
                <label>Authorized to work in the United Kingdom? *</label>
                <select value={workAuth.ukAuthorized} onChange={setWorkAuth("ukAuthorized")}>
                  <option value="">Select</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
              <div className="field">
                <label>Need visa sponsorship now or later? *</label>
                <select value={workAuth.needsVisaSponsorship} onChange={setWorkAuth("needsVisaSponsorship")}>
                  <option value="">Select</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {activeSection === "availability" && (
          <div className="profile-card">
            <h2>Availability</h2>
            <p className="section-hint">Used to answer start date, notice period, and scheduling questions on job applications</p>
            <div className="field-grid">
              <div className="field">
                <label>Notice Period *</label>
                <select value={profile.availability?.noticePeriod ?? ""} onChange={setAvailability("noticePeriod")}>
                  <option value="">Select</option>
                  <option value="Immediately">Immediately (no notice needed)</option>
                  <option value="1 week">1 week</option>
                  <option value="2 weeks">2 weeks</option>
                  <option value="3 weeks">3 weeks</option>
                  <option value="1 month">1 month</option>
                  <option value="2 months">2 months</option>
                  <option value="3 months">3 months</option>
                </select>
              </div>
              <div className="field">
                <label>Earliest Start Date</label>
                <input
                  value={profile.availability?.earliestStartDate ?? ""}
                  onChange={setAvailability("earliestStartDate")}
                  placeholder="e.g. Immediately, 2 weeks, June 2025"
                />
              </div>
              <div className="field">
                <label>Currently Employed?</label>
                <select value={profile.availability?.currentlyEmployed ?? ""} onChange={setAvailability("currentlyEmployed")}>
                  <option value="">Select</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {activeSection === "salary" && (
          <div className="profile-card">
            <h2>Salary Preferences</h2>
            <p className="section-hint">Used to answer compensation questions on job applications</p>
            <div className="field-grid">
              <div className="field">
                <label>Expected Salary</label>
                <input
                  value={profile.salary?.expected ?? ""}
                  onChange={setSalary("expected")}
                  placeholder="e.g. 90000 or Open to discussion"
                />
                <small className="mini-hint">Enter a number or "Open to discussion"</small>
              </div>
              <div className="field">
                <label>Currency</label>
                <select value={profile.salary?.currency ?? "USD"} onChange={setSalary("currency")}>
                  <option value="USD">USD</option>
                  <option value="CAD">CAD</option>
                  <option value="GBP">GBP</option>
                  <option value="EUR">EUR</option>
                  <option value="AUD">AUD</option>
                  <option value="INR">INR</option>
                </select>
              </div>
              <div className="field">
                <label>Open to Negotiation?</label>
                <select value={profile.salary?.openToNegotiation ?? ""} onChange={setSalary("openToNegotiation")}>
                  <option value="">Select</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {activeSection === "workPreferences" && (
          <div className="profile-card">
            <h2>Work Preferences</h2>
            <p className="section-hint">Used to answer in-person %, remote, relocation, and travel questions on applications</p>
            <div className="field-grid">
              <div className="field">
                <label>Preferred Work Mode *</label>
                <select value={profile.workPreferences?.mode ?? ""} onChange={setWorkPreferences("mode")}>
                  <option value="">Select</option>
                  <option value="remote">Remote (fully remote preferred)</option>
                  <option value="hybrid">Hybrid (some in-person okay)</option>
                  <option value="onsite">Onsite (prefer in-office)</option>
                  <option value="flexible">Flexible (open to anything)</option>
                </select>
              </div>
              <div className="field">
                <label>Willing to Relocate?</label>
                <select value={profile.workPreferences?.willingToRelocate ?? ""} onChange={setWorkPreferences("willingToRelocate")}>
                  <option value="">Select</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
              <div className="field">
                <label>Max Travel % Comfortable With</label>
                <select value={profile.workPreferences?.travelPercent ?? ""} onChange={setWorkPreferences("travelPercent")}>
                  <option value="">Select</option>
                  <option value="0">0% (no travel)</option>
                  <option value="10">Up to 10%</option>
                  <option value="25">Up to 25%</option>
                  <option value="50">Up to 50%</option>
                  <option value="75">Up to 75%</option>
                  <option value="100">100% (fully mobile)</option>
                </select>
                <small className="mini-hint">e.g. If "25%" selected and form asks "willing to travel 10%?" → Yes; "50%?" → No</small>
              </div>
              <div className="field">
                <label>Max In-Person % Comfortable With</label>
                <select value={profile.workPreferences?.inPersonPercent ?? ""} onChange={setWorkPreferences("inPersonPercent")}>
                  <option value="">Select</option>
                  <option value="0">0% (fully remote)</option>
                  <option value="10">Up to 10%</option>
                  <option value="25">Up to 25%</option>
                  <option value="50">Up to 50%</option>
                  <option value="75">Up to 75%</option>
                  <option value="100">100% (fully in-person)</option>
                </select>
                <small className="mini-hint">e.g. If "25%" selected and form asks "open to 25% in-person?" → Yes; "50%?" → No</small>
              </div>
            </div>
          </div>
        )}

        {activeSection === "eeo" && (
          <div className="profile-card">
            <h2>EEO (Optional)</h2>
            <p className="section-hint">All answers are optional and can be set to Decline</p>
            <div className="field">
              <label>Ethnicity</label>
              <div className="checkbox-grid">
                {["Asian", "Black or African American", "Hispanic or Latino", "Native American", "White", "Two or more races"].map((ethnicity) => (
                  <label key={ethnicity} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={eeo.ethnicities.includes(ethnicity)}
                      onChange={() => toggleEthnicity(ethnicity)}
                      disabled={eeo.declineEthnicity}
                    />
                    {ethnicity}
                  </label>
                ))}
              </div>
              <label className="checkbox-row">
                <input type="checkbox" checked={eeo.declineEthnicity} onChange={toggleDeclineEthnicity} />
                Decline to state
              </label>
            </div>
            <div className="field-grid">
              <div className="field">
                <label>Do you have a disability?</label>
                <select value={eeo.disability} onChange={setEeo("disability")}>
                  <option value="">Decline to state</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                  <option value="decline">Decline</option>
                </select>
              </div>
              <div className="field">
                <label>Are you a veteran?</label>
                <select value={eeo.veteran} onChange={setEeo("veteran")}>
                  <option value="">Decline to state</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                  <option value="decline">Decline</option>
                </select>
              </div>
              <div className="field">
                <label>Do you identify as LGBTQ+?</label>
                <select value={eeo.lgbtq} onChange={setEeo("lgbtq")}>
                  <option value="">Decline to state</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                  <option value="decline">Decline</option>
                </select>
              </div>
              <div className="field">
                <label>Gender</label>
                <select value={eeo.gender} onChange={setEeo("gender")}>
                  <option value="">Decline to state</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="non-binary">Non-binary</option>
                  <option value="decline">Decline</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {activeSection === "skills" && (
          <div className="profile-card">
            <h2>Skills</h2>
            <p className="section-hint">Add and mark preferred skills for relevance ranking</p>
            <div className="pill-input-row">
              <input
                value={skillInput}
                onChange={(e) => setSkillInput(e.target.value)}
                placeholder="Type skill and click Add"
              />
              <button type="button" className="save-btn" onClick={addSkill}>Add</button>
            </div>
            <div className="chip-list">
              {(profile.skills ?? []).map((skill) => (
                <div key={skill.name} className="chip">
                  <span>{skill.name}</span>
                  <button type="button" onClick={() => togglePreferredSkill(skill.name)} title="Toggle preferred">
                    {skill.preferred ? "♥" : "♡"}
                  </button>
                  <button type="button" onClick={() => removeSkill(skill.name)} title="Remove">×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeSection === "personal" && (
          <div className="profile-card">
            <h2>Personal</h2>
            <p className="section-hint">Personal contact and identifying details</p>
            <div className="field-row">
              <div className="field">
                <label>First Name *</label>
                <input value={profile.firstName} onChange={set("firstName")} placeholder="Jane" />
              </div>
              <div className="field">
                <label>Last Name *</label>
                <input value={profile.lastName} onChange={set("lastName")} placeholder="Doe" />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Email *</label>
                <input value={profile.email} onChange={set("email")} placeholder="jane@email.com" />
              </div>
              <div className="field">
                <label>Phone Number *</label>
                <input value={profile.phone} onChange={set("phone")} placeholder="+1 555 000 0000" />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Current Location (City) *</label>
                <input value={profile.location} onChange={set("location")} placeholder="San Francisco" />
              </div>
              <div className="field">
                <label>Date of Birth *</label>
                <input
                  type="date"
                  value={profile.personal?.dateOfBirth ?? ""}
                  onChange={(e) => {
                    const value = e.target.value;
                    setSaved(false);
                    setSectionWarning("");
                    setProfile((prev) => ({ ...prev, personal: { ...prev.personal, dateOfBirth: value } }));
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {activeSection === "links" && (
          <div className="profile-card">
            <h2>Links</h2>
            <p className="section-hint">Public links used by job portals</p>
            <div className="field-grid">
              <div className="field">
                <label>LinkedIn</label>
                <input value={links.linkedin} onChange={setLink("linkedin")} placeholder="https://linkedin.com/in/yourname" />
              </div>
              <div className="field">
                <label>GitHub</label>
                <input value={links.github} onChange={setLink("github")} placeholder="https://github.com/yourname" />
              </div>
              <div className="field">
                <label>Portfolio</label>
                <input value={links.portfolio} onChange={setLink("portfolio")} placeholder="https://yourportfolio.com" />
              </div>
              <div className="field">
                <label>Other</label>
                <input value={links.other} onChange={setLink("other")} placeholder="https://example.com" />
              </div>
            </div>
          </div>
        )}

        <div className="save-row">
          {saved && <span className="saved-badge">✓ Saved</span>}
          {sectionWarning && <span className="warn-badge">{sectionWarning}</span>}
          {activeStep > 0 && (
            <button className="edit-profile-btn" type="button" onClick={() => setActiveStep((prev) => prev - 1)}>
              ← Back
            </button>
          )}
          <button className="save-btn" type="button" onClick={handleSaveAndContinue}>
            {activeStep === PROFILE_SECTIONS.length - 1 ? "Save Profile & Continue →" : "Save and Continue →"}
          </button>
        </div>
        </div>
      }
    />
  );
}

function ProfileOverviewScreen({
  user,
  profile,
  onEdit,
  onGoApply,
  onLogout
}: {
  user: AuthUser;
  profile: UserProfile;
  onEdit: () => void;
  onGoApply: () => void;
  onLogout: () => void;
}) {
  const education = profile.education?.filter((entry) => entry.school || entry.major || entry.degree) ?? [];
  const experience = profile.experience?.filter((entry) => entry.title || entry.company) ?? [];
  const skills = (profile.skills ?? []).map((skill) => skill.name).filter(Boolean);
  const roles = profile.roles?.desiredRoles ?? [];
  const links = profile.links ?? EMPTY_LINKS;
  const uploadedResumePdf = useMemo(() => getStoredResumePdf(), [profile.resumeText]);
  const storedResumeDiff = useMemo(() => getStoredResumeDiff()?.snapshot ?? null, [profile.resumeText]);
  const storedResumeDiffLines = useMemo(() => {
    if (!storedResumeDiff) return [];
    return buildResumeLineDiff(storedResumeDiff.before, storedResumeDiff.canonical, storedResumeDiff);
  }, [storedResumeDiff]);

  return (
    <DashboardLayout
      sidebar={
        <DashboardSidebar
          userName={`${user.firstName} ${user.lastName}`}
          userEmail={user.email}
          activeItem="Profile"
          onNavigateApply={onGoApply}
          onNavigateJobs={onGoApply}
          onNavigateProfile={onEdit}
          onNavigateSettings={onGoApply}
          onLogout={onLogout}
        />
      }
      leftRail={
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-sm text-slate-500">Profile</p>
          <h2 className="text-xl font-semibold text-slate-900">Your Saved Details</h2>
          <p className="text-sm text-slate-500">Your profile is already filled. Use Edit only when you want to change something.</p>
          <button className="save-btn" type="button" onClick={onEdit}>Edit Profile</button>
          <button className="edit-profile-btn" type="button" onClick={onGoApply}>Back To Apply</button>
        </div>
      }
      main={
        <div className="space-y-4">
          <div className="profile-card">
            <h2>Personal</h2>
            <div className="field-grid">
              <div className="field"><label>First Name</label><input value={profile.firstName} disabled readOnly /></div>
              <div className="field"><label>Last Name</label><input value={profile.lastName} disabled readOnly /></div>
              <div className="field"><label>Email</label><input value={profile.email} disabled readOnly /></div>
              <div className="field"><label>Phone</label><input value={profile.phone} disabled readOnly /></div>
              <div className="field"><label>Location</label><input value={profile.location} disabled readOnly /></div>
              <div className="field"><label>Date of Birth</label><input value={profile.personal?.dateOfBirth ?? ""} disabled readOnly /></div>
            </div>
          </div>

          <div className="profile-card">
            <h2>Resume</h2>
            {uploadedResumePdf ? (
              <>
                <p className="section-hint">Uploaded resume type: PDF</p>
                <button
                  className="save-btn"
                  type="button"
                  onClick={() => window.open(uploadedResumePdf.dataUrl, "_blank", "noopener,noreferrer")}
                >
                  Open uploaded resume: {uploadedResumePdf.fileName}
                </button>
              </>
            ) : (
              <p className="section-hint">No resume uploaded yet.</p>
            )}

            {storedResumeDiff ? (
              <>
                <p className="section-hint" style={{ marginTop: 10 }}>Latest optimized resume diff</p>
                {storedResumeDiff.injectedSkills.length > 0 && (
                  <p className="section-hint">Injected missing skills: {storedResumeDiff.injectedSkills.join(", ")}</p>
                )}
                <div className="resume-diff-view" style={{ maxHeight: 260 }}>
                  {storedResumeDiffLines.map((line, index) => (
                    <div key={`overview-diff-${line.type}-${index}`} className={`resume-diff-line ${line.type}`}>
                      <span className="resume-diff-prefix">{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}</span>
                      <span>{line.text || " "}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          <div className="profile-card">
            <h2>Roles & Skills</h2>
            <p className="section-hint">Desired roles: {roles.length ? roles.join(", ") : "Not provided"}</p>
            <p className="section-hint">Preferred locations: {(profile.roles?.preferredLocations ?? []).join(", ") || "Not provided"}</p>
            <p className="section-hint">Employment types: {(profile.roles?.employmentTypes ?? []).join(", ") || "Not provided"}</p>
            <p className="section-hint">Skills: {skills.length ? skills.join(", ") : "Not provided"}</p>
          </div>

          <div className="profile-card">
            <h2>Education</h2>
            {education.length === 0 ? (
              <p className="section-hint">No education entries saved.</p>
            ) : (
              education.map((entry, index) => (
                <div key={`overview-edu-${index}`} className="section-hint" style={{ marginBottom: 10 }}>
                  {entry.degree} in {entry.major} - {entry.school}
                </div>
              ))
            )}
          </div>

          <div className="profile-card">
            <h2>Experience</h2>
            {experience.length === 0 ? (
              <p className="section-hint">No experience entries saved.</p>
            ) : (
              experience.map((entry, index) => (
                <div key={`overview-exp-${index}`} className="section-hint" style={{ marginBottom: 10 }}>
                  {entry.title} at {entry.company}
                </div>
              ))
            )}
          </div>

          <div className="profile-card">
            <h2>Links</h2>
            <p className="section-hint">LinkedIn: {links.linkedin || "Not provided"}</p>
            <p className="section-hint">GitHub: {links.github || "Not provided"}</p>
            <p className="section-hint">Portfolio: {links.portfolio || "Not provided"}</p>
            <p className="section-hint">Other: {links.other || "Not provided"}</p>
          </div>
        </div>
      }
    />
  );
}

// ──────────────────────────────────────────────
// Onboarding Chat Screen
// ──────────────────────────────────────────────

const ONBOARDING_SECTIONS = [
  { key: "education", label: "Education", icon: "🎓" },
  { key: "experience", label: "Experience", icon: "💼" },
  { key: "workAuth", label: "Work Authorization", icon: "📋" },
  { key: "eeo", label: "EEO (Optional)", icon: "🏷" },
  { key: "skills", label: "Skills", icon: "⚡" },
  { key: "personal", label: "Personal Info", icon: "👤" },
  { key: "links", label: "Links", icon: "🔗" }
];

type ChatMsg = { role: "user" | "assistant" | "system"; content: string };

function OnboardingScreen({
  user,
  resumeText: initialResumeText,
  onComplete
}: {
  user: AuthUser;
  resumeText: string;
  onComplete: (profile: UserProfile) => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentSection, setCurrentSection] = useState("education");
  const [doneSections, setDoneSections] = useState<Set<string>>(new Set());
  const [collectedData, setCollectedData] = useState<Record<string, unknown>>({});
  const [isComplete, setIsComplete] = useState(false);
  const [activeResumeText, setActiveResumeText] = useState(initialResumeText);
  const [onboardingStarted, setOnboardingStarted] = useState(!!initialResumeText);
  const [resumeInput, setResumeInput] = useState("");
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasSentInitial = useRef(false);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Send initial message once onboarding is started
  useEffect(() => {
    if (!onboardingStarted || hasSentInitial.current) return;
    hasSentInitial.current = true;

    const initialMsg = activeResumeText
      ? "I have uploaded my resume. Please extract my information."
      : "I don't have a resume. Let's start from scratch.";

    setMessages([{ role: "system", content: "AI onboarding started. Let's build your profile!" }]);
    void sendChat(initialMsg, true);
  }, [onboardingStarted, activeResumeText]);

  const startWithResume = () => {
    if (!resumeInput.trim()) return;
    setActiveResumeText(resumeInput);
    setOnboardingStarted(true);
  };

  const startFromScratch = () => {
    setActiveResumeText("");
    setOnboardingStarted(true);
  };

  const sendChat = async (userMessage: string, isInitial = false) => {
    const userMsg: ChatMsg = { role: "user", content: userMessage };
    const newMessages = isInitial
      ? [{ role: "system" as const, content: "AI onboarding started. Let's build your profile!" }, userMsg]
      : [...messages, userMsg];

    if (!isInitial) {
      setMessages(prev => [...prev, userMsg]);
    } else {
      setMessages(newMessages);
    }

    setInput("");
    setLoading(true);

    try {
      // Build the API messages (exclude system messages)
      const apiMessages: OnboardingMessage[] = newMessages
        .filter(m => m.role !== "system")
        .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

      const response: OnboardingResponse = await sendOnboardingMessage(
        apiMessages,
        isInitial ? activeResumeText : undefined
      );

      const assistantMsg: ChatMsg = { role: "assistant", content: response.message };
      setMessages(prev => [...prev, assistantMsg]);
      setProgress(response.progress);
      setCurrentSection(response.section);

      // Track completed sections
      if (response.data) {
        setCollectedData(prev => ({ ...prev, ...response.data }));
      }

      // Mark sections as done based on progress
      if (response.action === "confirm" || response.action === "update" || response.action === "skip") {
        // When we move to a new section, mark the previous one as done
        setDoneSections(prev => {
          const next = new Set(prev);
          const currentIdx = ONBOARDING_SECTIONS.findIndex(s => s.key === response.section);
          for (let i = 0; i < currentIdx; i++) {
            next.add(ONBOARDING_SECTIONS[i].key);
          }
          return next;
        });
      }

      // Handle completion
      if (response.action === "complete") {
        setIsComplete(true);
        setDoneSections(new Set(ONBOARDING_SECTIONS.map(s => s.key)));

        // Save the onboarding profile
        if (response.data) {
          saveOnboardingProfile(response.data as any);
        }
      }
    } catch (err) {
      setMessages(prev => [
        ...prev,
        { role: "assistant", content: "Sorry, something went wrong. Please try again." }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleSend = () => {
    if (!input.trim() || loading) return;
    void sendChat(input.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleComplete = () => {
    // Build a UserProfile from collected data
    const data = collectedData as any;
    const personal = data.personal ?? {};
    const links = data.links ?? {};
    const experience = data.experience ?? [];
    const education = data.education ?? [];
    const skills = data.skills ?? [];
    const workAuth = data.workAuth ?? {};
    const eeo = data.eeo ?? {};

    // Generate a unified "answers" record for the form filler
    const answers: Record<string, string> = {};
    
    // Flatten workAuth and eeo into questions for the worker
    Object.entries(workAuth).forEach(([k, v]) => { answers[k] = String(v); });
    Object.entries(eeo).forEach(([k, v]) => { answers[k] = String(v); });
    
    // Add specific fields that might be asked individually
    if (personal.phone) answers["Phone"] = personal.phone;
    if (personal.location) answers["Location"] = personal.location;
    if (links.linkedin) answers["LinkedIn"] = links.linkedin;
    if (links.portfolio) answers["Portfolio"] = links.portfolio;

    const profile: UserProfile = {
      firstName: personal.firstName || user.firstName,
      lastName: personal.lastName || user.lastName,
      email: personal.email || user.email,
      phone: personal.phone || "",
      location: personal.location || "",
      resumeText: activeResumeText,
      linkedIn: links.linkedin || "",
      portfolio: links.portfolio || links.github || "",
      yearsExperience: experience.length > 0 ? String(experience.length) : "0",
      whyCompany: "",
      education,
      experience,
      skills,
      workAuth,
      eeo,
      answers
    };

    saveProfile(profile);
    onComplete(profile);
  };

  if (!onboardingStarted) {
    return (
      <div className="onboarding-wrap">
        <aside className="onboarding-sidebar">
          <div className="sidebar-header">
            <span className="logo-icon-sm">⚡</span>
            <h2>AutoApply</h2>
          </div>
          <p className="sidebar-hint">
             Welcome, {user.firstName}! Let&apos;s build your AI profile to start automating your job applications.
          </p>
        </aside>
        <main className="onboarding-main">
          <div className="onboarding-header">
            <h3>Getting Started</h3>
          </div>
          <div className="onboarding-complete-card" style={{ margin: "auto", animation: "chatFadeIn 0.5s ease" }}>
            <div className="complete-icon">📄</div>
            <h2>Import Your Resume</h2>
            <p>Paste your resume text here to let our AI automatically extract your details and build your profile in seconds.</p>
            <textarea 
               className="resume-area" 
               style={{ minHeight: "150px", marginBottom: "10px" }}
               placeholder="Paste your resume text here..."
               value={resumeInput}
               onChange={(e) => setResumeInput(e.target.value)}
            />
            <button className="complete-btn" onClick={startWithResume} disabled={!resumeInput.trim()}>
              Start Extraction →
            </button>
            <button className="skip-btn" onClick={startFromScratch} style={{ marginTop: "10px" }}>
              I&apos;ll type my details manually
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (isComplete) {
    return (
      <div className="onboarding-wrap">
        <aside className="onboarding-sidebar">
          <div className="sidebar-header">
            <span className="logo-icon-sm">⚡</span>
            <h2>AutoApply</h2>
          </div>
          <div className="onboarding-progress-section">
            <div className="progress-label">
              <span>Profile Complete</span>
              <span>100%</span>
            </div>
            <div className="onboarding-progress-bar">
              <div className="onboarding-progress-fill" style={{ width: "100%" }} />
            </div>
          </div>
          <div className="onboarding-sections">
            {ONBOARDING_SECTIONS.map(s => (
              <div key={s.key} className="onboarding-section-item done">
                <span className="section-icon">✓</span>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        </aside>
        <main className="onboarding-main">
          <div className="onboarding-complete-card">
            <div className="complete-icon">🎉</div>
            <h2>Profile Complete!</h2>
            <p>Your profile has been built successfully. You&apos;re ready to start auto-applying to jobs.</p>
            <button className="complete-btn" onClick={handleComplete}>Start Applying →</button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="onboarding-wrap">
      <aside className="onboarding-sidebar">
        <div className="sidebar-header">
          <span className="logo-icon-sm">⚡</span>
          <h2>AutoApply</h2>
        </div>
        <p className="sidebar-hint">
          Our AI assistant will guide you through building your profile step by step.
        </p>

        <div className="onboarding-progress-section">
          <div className="progress-label">
            <span>Progress</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="onboarding-progress-bar">
            <div className="onboarding-progress-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="onboarding-sections">
          {ONBOARDING_SECTIONS.map(s => (
            <div
              key={s.key}
              className={`onboarding-section-item ${
                doneSections.has(s.key) ? "done" : s.key === currentSection ? "active" : ""
              }`}
            >
              <span className="section-icon">
                {doneSections.has(s.key) ? "✓" : s.icon}
              </span>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      </aside>

      <main className="onboarding-main">
        <div className="onboarding-header">
          <h3>AI Profile Builder</h3>
          <button className="skip-btn" onClick={handleComplete}>Skip & Use Defaults</button>
        </div>

        <div className="chat-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`chat-bubble ${msg.role}`}>
              {msg.content}
            </div>
          ))}
          {loading && (
            <div className="typing-indicator">
              <div className="typing-dot" />
              <div className="typing-dot" />
              <div className="typing-dot" />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-input-area">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your answer…"
            disabled={loading}
          />
          <button
            className="chat-send-btn"
            onClick={handleSend}
            disabled={loading || !input.trim()}
          >
            →
          </button>
        </div>
      </main>
    </div>
  );
}

// ──────────────────────────────────────────────
// Apply Screen
// ──────────────────────────────────────────────

function ApplyScreen({
  user,
  profile,
  onEditProfile,
  onLogout
}: {
  user: AuthUser;
  profile: UserProfile;
  onEditProfile: () => void;
  onLogout: () => void;
}) {
  const [jobUrl, setJobUrl] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [runData, setRunData] = useState<AppData | null>(null);
  const [loading, setLoading] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState("");
  const [livePreviewUrl, setLivePreviewUrl] = useState("");
  const previewPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const progress = useMemo(() => {
    if (!runData) return 0;
    const idx = ORDERED_STEPS.indexOf(runData.currentStep);
    return Math.max(0, ((idx + 1) / ORDERED_STEPS.length) * 100);
  }, [runData]);

  // Extract HTTP screenshotUrl from events (set by worker)
  const eventPreviewUrl = useMemo(() => {
    const events = runData?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const payload = events[i].payloadJson;
      const url = payload?.screenshotUrl as string | undefined;
      if (url && typeof url === "string") return url;
    }
    return "";
  }, [runData]);

  // Prefer live-polled URL (refreshed every 2s), fall back to last event's URL
  const latestPreview = livePreviewUrl || eventPreviewUrl;

  const resumeDiffData = useMemo(() => {
    return extractResumeDiffFromEvents(runData?.events ?? []);
  }, [runData]);

  const resumeDiffLines = useMemo(() => {
    if (!resumeDiffData) return [];
    return buildResumeLineDiff(resumeDiffData.before, resumeDiffData.canonical, resumeDiffData);
  }, [resumeDiffData]);

  const runSummary = useMemo(() => {
    const initialScore = resumeDiffData?.scoreBefore;
    const finalScore = resumeDiffData?.scoreAfter;
    const missingSkillsInjected = resumeDiffData?.injectedSkills.length ?? 0;
    const resumeTailored = Boolean(resumeDiffData?.tailoringTriggered && !resumeDiffData?.fallbackUsed);
    return {
      initialScore,
      finalScore,
      missingSkillsInjected,
      resumeTailored,
      status: runData?.status ?? "idle"
    };
  }, [resumeDiffData, runData]);

  const impactMetrics = useMemo(() => {
    const skillBefore = resumeDiffData?.skillMatchBefore;
    const skillAfter = resumeDiffData?.skillMatchAfter;
    const keywordBefore = resumeDiffData?.keywordOverlapBefore;
    const keywordAfter = resumeDiffData?.keywordOverlapAfter;

    return {
      skillDelta: typeof skillBefore === "number" && typeof skillAfter === "number" ? skillAfter - skillBefore : null,
      keywordDelta: typeof keywordBefore === "number" && typeof keywordAfter === "number" ? keywordAfter - keywordBefore : null
    };
  }, [resumeDiffData]);

  useEffect(() => {
    if (!resumeDiffData) return;
    saveStoredResumeDiff(resumeDiffData);
  }, [resumeDiffData]);

  const refresh = useCallback(async () => {
    if (!applicationId) return;
    try {
      const details = await getApplication(applicationId);
      setRunData(details);
    } catch { /* ignore */ }
  }, [applicationId]);

  useEffect(() => {
    if (!applicationId) {
      setIsLive(false);
      setLivePreviewUrl("");
      if (previewPollRef.current) { clearInterval(previewPollRef.current); previewPollRef.current = null; }
      return;
    }

    // Live preview poll every 2 seconds
    previewPollRef.current = setInterval(() => {
      void getLatestPreview(applicationId).then(url => {
        if (url) setLivePreviewUrl(`${url}?t=${Date.now()}`);
      });
    }, 2000);

    const unsub = subscribeToApplication(applicationId, () => {
      void refresh();
      setIsLive(true);
    });
    const interval = window.setInterval(() => { void refresh(); }, 6000);
    return () => {
      unsub();
      clearInterval(interval);
      if (previewPollRef.current) { clearInterval(previewPollRef.current); previewPollRef.current = null; }
      setIsLive(false);
    };
  }, [applicationId, refresh]);

  const submitJob = async () => {
    if (!jobUrl || !targetRole) return;
    setError("");
    setLoading(true);
    try {
      const created = await createApplication({
        jobUrl,
        targetRole,
        metadata: {
          profile: {
            firstName: profile.firstName,
            lastName: profile.lastName,
            email: profile.email,
            phone: profile.phone,
            location: profile.location,
            linkedIn: profile.linkedIn,
            portfolio: profile.portfolio
          },
          resumeText: profile.resumeText,
          answers: {
            ...buildProfileAnswers(profile),
            "why-this-company": profile.whyCompany || "I am excited about this opportunity.",
            "years-experience": profile.yearsExperience || "0"
          }
        }
      });
      setApplicationId(created.applicationId);
      const details = await getApplication(created.applicationId);
      setRunData(details);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message ?? "Failed to start application";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const pause = async () => { if (!applicationId) return; await pauseApplication(applicationId); await refresh(); };
  const resume = async () => { if (!applicationId) return; await resumeApplication(applicationId); await refresh(); };
  const newApplication = () => {
    setJobUrl(""); setTargetRole(""); setApplicationId(""); setRunData(null);
    setError(""); setIsLive(false); setLivePreviewUrl("");
    if (previewPollRef.current) { clearInterval(previewPollRef.current); previewPollRef.current = null; }
  };

  const statusColor = (s: string) => {
    if (s === "completed") return "#22c55e";
    if (s === "failed") return "#ef4444";
    if (s === "paused") return "#f59e0b";
    if (s === "running") return "#3b82f6";
    return "#94a3b8";
  };

  return (
    <div className="app-shell">
      {/* Left panel */}
      <aside className="left-panel">
        <div className="panel-header">
          <span className="logo-icon-sm">⚡</span>
          <div style={{ flex: 1 }}>
            <h2>AutoApply</h2>
            <p className="user-email">{user.firstName} · {user.email}</p>
          </div>
        </div>

        <nav className="nav-items">
          <div className="nav-item active">🚀 Apply</div>
          <div className="nav-item" onClick={onEditProfile}>👤 Profile</div>
          <div className="nav-item logout" onClick={onLogout}>⎋ Sign Out</div>
        </nav>

        <div className="divider" />

        <div className="profile-summary">
          <div className="ps-name">{profile.firstName} {profile.lastName}</div>
          <div className="ps-sub">{profile.email}</div>
          <div className="ps-sub">{profile.phone} · {profile.location}</div>
          <button className="edit-profile-btn" onClick={onEditProfile}>Edit Profile</button>
        </div>

        <div className="divider" />

        <label>Job URL</label>
        <input
          value={jobUrl}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setJobUrl(e.target.value)}
          placeholder="https://boards.greenhouse.io/..."
          disabled={loading || !!applicationId}
        />
        <label>Target Role</label>
        <input
          value={targetRole}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setTargetRole(e.target.value)}
          placeholder="Senior Software Engineer"
          disabled={loading || !!applicationId}
        />

        {error && <div className="inline-error">{error}</div>}

        {!applicationId ? (
          <button className="start-btn" onClick={submitJob} disabled={loading || !jobUrl || !targetRole}>
            {loading ? "⏳ Launching…" : "🚀 Start Application"}
          </button>
        ) : (
          <>
            <button className="new-btn" onClick={newApplication}>＋ New Application</button>
            <div className="control-row">
              <button onClick={pause} disabled={!applicationId || runData?.status === "paused"}>⏸ Pause</button>
              <button onClick={resume} disabled={!applicationId || runData?.status === "running"}>▶ Resume</button>
              <button onClick={refresh} disabled={!applicationId}>↻ Refresh</button>
            </div>
          </>
        )}
      </aside>

      {/* Main panel */}
      <main className="main-panel">
        <section className="resume-diff-card">
          <h2>Run Summary</h2>
          <div className="status-grid">
            <div>
              <span>Initial Score</span>
              <strong>{typeof runSummary.initialScore === "number" ? `${runSummary.initialScore}%` : "-"}</strong>
            </div>
            <div>
              <span>Final Score</span>
              <strong>{typeof runSummary.finalScore === "number" ? `${runSummary.finalScore}%` : "-"}</strong>
            </div>
            <div>
              <span>Missing Skills Injected</span>
              <strong>{runSummary.missingSkillsInjected}</strong>
            </div>
            <div>
              <span>Resume Tailored</span>
              <strong>{runSummary.resumeTailored ? "YES" : "NO"}</strong>
            </div>
            <div>
              <span>Application Status</span>
              <strong>{runSummary.status}</strong>
            </div>
          </div>
        </section>

        <section className="resume-diff-card">
          <h2>Tailoring Decision</h2>
          <div className="status-grid">
            <div>
              <span>Score</span>
              <strong>{typeof resumeDiffData?.scoreAfter === "number" ? `${resumeDiffData.scoreAfter}%` : "-"}</strong>
            </div>
            <div>
              <span>Threshold</span>
              <strong>{typeof resumeDiffData?.threshold === "number" ? `${resumeDiffData.threshold}%` : "-"}</strong>
            </div>
            <div>
              <span>Triggered</span>
              <strong>{resumeDiffData?.tailoringTriggered ? "YES" : "NO"}</strong>
            </div>
          </div>
        </section>

        {/* Status bar */}
        <section className="status-card">
          <div className="status-header">
            <h2>Application Run</h2>
            {isLive && <span className="live-badge">● LIVE</span>}
          </div>
          <div className="status-grid">
            <div>
              <span>Status</span>
              <strong style={{ color: statusColor(runData?.status ?? "idle") }}>
                {runData?.status ?? "idle"}
              </strong>
            </div>
            <div>
              <span>Step</span>
              <strong>{runData?.currentStep ?? "—"}</strong>
            </div>
            <div>
              <span>Progress</span>
              <strong>{progress.toFixed(0)}%</strong>
            </div>
            <div>
              <span>Stream</span>
              <strong>{isLive ? "live" : "polling"}</strong>
            </div>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>

          {/* Step pipeline */}
          <div className="pipeline">
            {ORDERED_STEPS.map((step) => {
              const currentIdx = ORDERED_STEPS.indexOf(runData?.currentStep ?? "");
              const stepIdx = ORDERED_STEPS.indexOf(step);
              const done = currentIdx > stepIdx;
              const active = currentIdx === stepIdx;
              return (
                <div
                  key={step}
                  className={`pipeline-step ${done ? "done" : ""} ${active ? "active" : ""}`}
                  title={step}
                >
                  <div className="pip-dot" />
                  <span>{step.replace(/_/g, " ")}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Browser preview + logs */}
        <section className="resume-diff-card">
          <h2>Resume Used for Application</h2>
          {resumeDiffData ? (
            <>
              <p className="section-hint">{resumeDiffData.fallbackUsed ? "⚠ Tailoring failed — original resume was used" : "✔ This version was submitted"}</p>

              <div className="status-grid" style={{ marginBottom: 10 }}>
                <div>
                  <span>Score</span>
                  <strong>{typeof resumeDiffData.scoreAfter === "number" ? `${resumeDiffData.scoreAfter}%` : "-"}</strong>
                </div>
                <div>
                  <span>Threshold</span>
                  <strong>{resumeDiffData.threshold}%</strong>
                </div>
                <div>
                  <span>Triggered</span>
                  <strong>{resumeDiffData.tailoringTriggered ? "YES" : "NO"}</strong>
                </div>
              </div>

              <div className="status-grid" style={{ marginBottom: 10 }}>
                <div>
                  <span>Version</span>
                  <strong>{resumeDiffData.version}</strong>
                </div>
                <div>
                  <span>Generated For</span>
                  <strong>{resumeDiffData.generatedFor}</strong>
                </div>
                <div>
                  <span>Timestamp</span>
                  <strong>{new Date(resumeDiffData.generatedAt).toLocaleString()}</strong>
                </div>
              </div>

              <div className="status-grid" style={{ marginBottom: 10 }}>
                <div>
                  <span>Skill Match</span>
                  <strong>{impactMetrics.skillDelta === null ? "-" : `${impactMetrics.skillDelta >= 0 ? "+" : ""}${impactMetrics.skillDelta}%`}</strong>
                </div>
                <div>
                  <span>Keyword Overlap</span>
                  <strong>{impactMetrics.keywordDelta === null ? "-" : `${impactMetrics.keywordDelta >= 0 ? "+" : ""}${impactMetrics.keywordDelta}%`}</strong>
                </div>
              </div>

              <h3 style={{ margin: "8px 0 6px", fontSize: "0.9rem" }}>Final Resume Preview</h3>
              <div className="resume-final-preview">{resumeDiffData.canonical}</div>

              <h3 style={{ margin: "10px 0 6px", fontSize: "0.9rem" }}>Optimization Diff</h3>
              <p className="section-hint">Green lines were added. Red lines were removed.</p>
              {resumeDiffData.injectedSkills.length > 0 && (
                <p className="section-hint">Injected missing skills: {resumeDiffData.injectedSkills.join(", ")}</p>
              )}
              <div className="resume-diff-view">
                {resumeDiffLines.map((line, index) => (
                  <div key={`${line.type}-${index}`} className={`resume-diff-line ${line.type}`}>
                    <span className="resume-diff-prefix">{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}</span>
                    <span>{line.text || " "}{line.type === "added" && line.reason ? `  -> ${line.reason}` : ""}</span>
                  </div>
                ))}
              </div>
            </>
          ) : runData?.currentStep === "resume_optimized" ? (
            <p className="section-hint">Resume optimization is running. Changes will appear here once tailoring completes.</p>
          ) : (
            <p className="section-hint">No optimized resume diff yet. Start an application to see resume changes.</p>
          )}
        </section>

        <section className="log-card">
          <h2>Live Automation Preview</h2>
          <div className="preview-frame">
            {latestPreview
              ? <img key={latestPreview} src={latestPreview} alt="Live browser view" />
              : <p>Browser preview will appear when automation starts.</p>
            }
          </div>

          <h2 style={{ marginTop: 20 }}>Execution Logs</h2>
          <div className="log-list">
            {(runData?.events ?? []).length === 0
              ? <p className="empty-logs">No logs yet. Start an application to see live progress.</p>
              : [...(runData?.events ?? [])].reverse().map((ev) => (
                <article key={ev.id} className="log-item">
                  <header>
                    <strong className="step-tag">{ev.step}</strong>
                    <span>{new Date(ev.createdAt).toLocaleTimeString()}</span>
                  </header>
                  <p>{ev.message}</p>
                </article>
              ))
            }
          </div>
        </section>
      </main>
    </div>
  );
}

// ──────────────────────────────────────────────
// Root App
// ──────────────────────────────────────────────

export function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile>(EMPTY_PROFILE);
  const [screen, setScreen] = useState<Screen>("auth");
  const [bootstrapping, setBootstrapping] = useState(true);

  const persistProfileAuthoritatively = useCallback(async (nextProfile: UserProfile): Promise<UserProfile> => {
    const normalized = normalizeProfile(nextProfile);
    setProfile(normalized);
    saveProfile(normalized);

    try {
      const saved = await putProfile(normalized);
      const authoritative = normalizeProfile(saved);
      setProfile(authoritative);
      saveProfile(authoritative);
      return authoritative;
    } catch {
      return normalized;
    }
  }, []);

  const hydrateProfileFromBackend = useCallback(async (me: AuthUser): Promise<UserProfile> => {
    try {
      const backendProfile = normalizeProfile(await getProfile());
      let authoritative = normalizeProfile({
        ...backendProfile,
        firstName: backendProfile.firstName || me.firstName,
        lastName: backendProfile.lastName || me.lastName,
        email: backendProfile.email || me.email
      });

      const cache = getStoredProfile();
      if (isProfileEffectivelyEmpty(authoritative) && cache && !isProfileEffectivelyEmpty(cache)) {
        authoritative = normalizeProfile(await putProfile(cache));
      }

      saveProfile(authoritative);
      return authoritative;
    } catch {
      const cache = getStoredProfile();
      if (cache) return normalizeProfile(cache);
      return normalizeProfile({ ...EMPTY_PROFILE, firstName: me.firstName, lastName: me.lastName, email: me.email });
    }
  }, []);

  // On mount: check for existing token/session
  useEffect(() => {
    const token = getStoredToken();
    if (!token) { setBootstrapping(false); return; }

    getMe()
      .then(async (me) => {
        setUser(me);
        const authoritativeProfile = await hydrateProfileFromBackend(me);
        setProfile(authoritativeProfile);
        if (profileComplete(authoritativeProfile)) {
          setScreen("apply");
        } else {
          setScreen("profile");
        }
      })
      .catch(() => {
        // Token expired or invalid
        localStorage.removeItem("autoapply_token");
        setScreen("auth");
      })
      .finally(() => setBootstrapping(false));
  }, []);

  const handleAuth = (u: AuthUser) => {
    setUser(u);
    void (async () => {
      const authoritativeProfile = await hydrateProfileFromBackend(u);
      setProfile(authoritativeProfile);
      setScreen(profileComplete(authoritativeProfile) ? "apply" : "profile");
    })();
  };

  const handleProfileSave = useCallback((p: UserProfile) => {
    void persistProfileAuthoritatively(p).then((saved) => {
      if (profileComplete(saved)) setScreen("apply");
    });
  }, [persistProfileAuthoritatively]);

  const handleLogout = () => {
    logout();
    setUser(null);
    setProfile(EMPTY_PROFILE);
    setScreen("auth");
  };

  if (bootstrapping) {
    return (
      <div className="boot-screen">
        <span className="logo-icon">⚡</span>
        <p>Loading AutoApply…</p>
      </div>
    );
  }

  if (screen === "auth" || !user) {
    return <AuthScreen onAuth={handleAuth} />;
  }

  if (screen === "profile") {
    return (
      <ProfileScreen
        user={user}
        initial={profile}
        onSave={handleProfileSave}
        onGoApply={() => setScreen("apply")}
        onLogout={handleLogout}
      />
    );
  }

  if (screen === "profileView") {
    return (
      <ProfileOverviewScreen
        user={user}
        profile={profile}
        onEdit={() => setScreen("profile")}
        onGoApply={() => setScreen("apply")}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <MainDashboardScreen
      user={user}
      profile={profile}
      onEditProfile={() => setScreen(profileComplete(profile) ? "profileView" : "profile")}
      onLogout={handleLogout}
    />
  );
}
