import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import {
  createApplication,
  getApplication,
  getLatestPreview,
  pauseApplication,
  resumeApplication,
  subscribeToApplication,
  type UserProfile
} from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Badge } from "../../components/ui/badge.js";
import { Dialog } from "../../components/ui/dialog.js";
import { ToastProvider, useToast } from "../../components/ui/toast.js";
import { getInternetJobs } from "../../api/queue.js";
import { analyzeJob } from "../../api/job.js";
import type { AnalyzeJobResponse, InternetJobItem } from "../../api/contracts.js";
import { deriveMatchScore, getResumeDiff, inferDecision, ORDERED_PIPELINE } from "./data.js";
import { ApprovalModal } from "./components/approval-modal.js";
import { DashboardSidebar } from "./components/dashboard-sidebar.js";
import { ExecutionLogs } from "./components/execution-logs.js";
import { JobInputPanel } from "./components/job-input-panel.js";
import { JobIntelligenceCard } from "./components/job-intelligence-card.js";
import { LiveAutomationPreview } from "./components/live-automation-preview.js";
import { PipelineStepper } from "./components/pipeline-stepper.js";
import { ResumeDiffPreview } from "./components/resume-diff-preview.js";
import { StructuredResumePreview, type StructuredResumeCanonical } from "./components/structured-resume-preview.js";
import { DashboardLayout } from "../../layouts/dashboard-layout.js";
import type { DashboardLog, PipelineStep, ResumeDiffLine } from "./types.js";

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

type EventLog = {
  id: string;
  step: string;
  message: string;
  createdAt: string;
  payloadJson?: { screenshotPath?: string; screenshotUrl?: string; [key: string]: unknown };
};

type AppData = {
  id: string;
  currentStep: string;
  status: string;
  jobUrl: string;
  targetRole: string;
  events: EventLog[];
};

type ResumeCanonical = StructuredResumeCanonical & {
  rawText?: string;
};

type ResumeDiff = {
  section: string;
  added?: string[];
  removed?: string[];
  reason?: string;
};

type ResumeOptimizationPayload = {
  resumeCanonical?: ResumeCanonical;
  originalResume: string;
  version: number;
  diff: ResumeDiff[];
  tailoringTriggered: boolean;
  fallbackUsed: boolean;
  tailoringError?: string;
  threshold: number;
};

type StoredResumePdf = {
  dataUrl: string;
  fileName: string;
};

type MainDashboardScreenProps = {
  user: { firstName: string; lastName: string; email: string };
  profile: UserProfile;
  onEditProfile: () => void;
  onLogout: () => void;
};

type DashboardNavItem = "Apply" | "Applications" | "ApplicationDetail" | "Jobs" | "Settings";
type ApplyMode = "assist" | "smart_auto" | "full_auto";

type JobHistoryItem = {
  id: string;
  jobUrl: string;
  targetRole: string;
  status: string;
  currentStep: string;
  updatedAt: string;
};

type DashboardJobRecord = {
  id: string;
  role: string;
  company: string;
  requirements: string[];
  description: string;
  url: string;
  source: "internet" | "history";
  status?: string;
};

type ApplicationPipelineStage = {
  key: "optimize" | "resume" | "generate" | "cover_letter" | "submit" | "done";
  label: string;
};

const JOB_HISTORY_STORAGE_KEY = "autoapply_dashboard_job_history";
const RESUME_PDF_DATA_URL_KEY = "autoapply_resume_pdf_data_url";
const RESUME_PDF_NAME_KEY = "autoapply_resume_pdf_name";
const APPLICATION_PIPELINE: ApplicationPipelineStage[] = [
  { key: "optimize", label: "Optimize" },
  { key: "resume", label: "Resume" },
  { key: "generate", label: "Generate" },
  { key: "cover_letter", label: "Cover Letter" },
  { key: "submit", label: "Submit" },
  { key: "done", label: "Done" }
];

function mapBackendStepToPipelineIndex(currentStep: string, status: string): number {
  const step = (currentStep || "").toLowerCase();
  const state = (status || "").toLowerCase();

  if (step.includes("submitted") || state.includes("submitted") || state.includes("completed") || state.includes("success")) {
    return 5;
  }
  if (step.includes("browser_started") || step.includes("logged_in") || step.includes("form_filled")) {
    return 4;
  }
  if (step.includes("answers_generated")) return 3;
  if (step.includes("resume_optimized")) return 1;
  if (step.includes("job_analyzed") || step.includes("job_scraped") || step.includes("queued")) return 0;
  return 0;
}

function isActiveApplicationStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return !(
    normalized.includes("submitted") ||
    normalized.includes("completed") ||
    normalized.includes("success") ||
    normalized.includes("failed") ||
    normalized.includes("cancelled")
  );
}

function normalizeStepLabel(step: string): string {
  return step.replace(/_/g, " ");
}

function mapPipelineSteps(currentStep: string): PipelineStep[] {
  const currentIndex = ORDERED_PIPELINE.indexOf(currentStep as (typeof ORDERED_PIPELINE)[number]);
  return ORDERED_PIPELINE.map((step, index) => {
    const state = currentIndex > index ? "completed" : currentIndex === index ? "active" : "pending";
    return {
      id: step,
      label: normalizeStepLabel(step),
      state
    };
  });
}

function mapLogs(events: EventLog[]): DashboardLog[] {
  return [...events]
    .reverse()
    .slice(0, 30)
    .map((event) => {
      let status: DashboardLog["status"] = "running";
      const step = event.step.toLowerCase();
      const message = event.message.toLowerCase();

      if (message.includes("error") || message.includes("failed")) status = "error";
      else if (step.includes("submitted") || message.includes("complete")) status = "success";
      else if (message.includes("retry") || message.includes("warn")) status = "warning";

      return {
        id: event.id,
        timestamp: new Date(event.createdAt).toLocaleTimeString(),
        action: event.message || normalizeStepLabel(event.step),
        status
      };
    });
}

function safeCompanyHost(url: string | undefined): string {
  if (!url) return "Waiting for job URL";
  try {
    return new URL(url).hostname;
  } catch {
    return "Waiting for job URL";
  }
}

function readJobHistoryFromStorage(): JobHistoryItem[] {
  try {
    const raw = localStorage.getItem(JOB_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((entry) => {
        const record = entry as Partial<JobHistoryItem>;
        if (!record?.id || !record?.jobUrl) return null;
        return {
          id: record.id,
          jobUrl: record.jobUrl,
          targetRole: record.targetRole ?? "Untitled role",
          status: record.status ?? "queued",
          currentStep: record.currentStep ?? "queued",
          updatedAt: record.updatedAt ?? new Date(0).toISOString()
        };
      })
      .filter((entry): entry is JobHistoryItem => !!entry);
  } catch {
    return [];
  }
}

function writeJobHistoryToStorage(items: JobHistoryItem[]): void {
  localStorage.setItem(JOB_HISTORY_STORAGE_KEY, JSON.stringify(items));
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

function buildResumeCanonical(canonical: ResumeCanonical): string {
  const lines: string[] = [];

  if (canonical.summary?.trim()) {
    lines.push("Summary:", canonical.summary.trim(), "");
  }

  if (canonical.skills?.length) {
    lines.push(`Skills: ${canonical.skills.join(", ")}`, "");
  }

  if (canonical.experience?.length) {
    lines.push("Experience:");
    canonical.experience.forEach((entry) => {
      const title = entry.title?.trim() || [entry.role, entry.company || entry.organization].filter(Boolean).join(" at ").trim();
      if (title) lines.push(title);
      (entry.bullets ?? []).forEach((bullet) => lines.push(`- ${bullet}`));
    });
    lines.push("");
  }

  if (canonical.projects?.length) {
    lines.push("Projects:");
    canonical.projects.forEach((entry) => {
      const title = entry.title?.trim() || "Project";
      lines.push(title);
      (entry.bullets ?? []).forEach((bullet) => lines.push(`- ${bullet}`));
    });
    lines.push("");
  }

  if (canonical.education?.length) {
    lines.push("Education:");
    canonical.education.forEach((entry) => {
      const title = entry.title?.trim() || entry.school?.trim() || entry.institution?.trim() || "Education";
      lines.push(title);
      (entry.details ?? []).forEach((detail) => lines.push(`- ${detail}`));
    });
  }

  return lines.join("\n").trim();
}

function isValidResumeCanonical(canonical: ResumeCanonical | undefined): canonical is ResumeCanonical {
  if (!canonical) return false;

  return Boolean(
    canonical.summary?.trim() ||
    canonical.skills?.length ||
    canonical.experience?.length ||
    canonical.projects?.length ||
    canonical.education?.length
  );
}

function normalizeForHighlight(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

type PdfHighlightRect = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

type ResumePdfHighlightViewerProps = {
  dataUrl: string;
  highlightLines: string[];
};

function ResumePdfHighlightViewer({ dataUrl, highlightLines }: ResumePdfHighlightViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [highlightRects, setHighlightRects] = useState<PdfHighlightRect[]>([]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");

    const task = getDocument(dataUrl);
    void task.promise.then((doc: any) => {
      if (disposed) return;
      setPdfDoc(doc);
      setPageCount(doc.numPages || 1);
      setCurrentPage(1);
      setLoading(false);
    }).catch(() => {
      if (disposed) return;
      setError("Could not load PDF preview.");
      setLoading(false);
    });

    return () => {
      disposed = true;
      void task.destroy();
    };
  }, [dataUrl]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;

    let cancelled = false;
    const activeHighlights = highlightLines.map((line) => normalizeForHighlight(line)).filter(Boolean);

    const render = async () => {
      try {
        const page = await pdfDoc.getPage(currentPage);
        if (cancelled || !canvasRef.current) return;

        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        await page.render({ canvasContext: context, viewport }).promise;
        if (cancelled) return;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        const rects: PdfHighlightRect[] = [];
        for (let idx = 0; idx < textContent.items.length; idx += 1) {
          const item = textContent.items[idx] as { str?: string; transform?: number[]; width?: number };
          const str = item.str ?? "";
          if (!str.trim()) continue;

          const normalized = normalizeForHighlight(str);
          if (!normalized || normalized.length < 4) continue;

          const shouldHighlight = activeHighlights.some((line) => line.includes(normalized));
          if (!shouldHighlight) continue;

          const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
          const x = transform[4] ?? 0;
          const y = transform[5] ?? 0;
          const height = Math.max(10, Math.hypot(transform[2] ?? 0, transform[3] ?? 0));
          const width = Math.max(16, (item.width ?? (str.length * 5)) * scale);

          rects.push({
            id: `hl-${idx}`,
            left: x,
            top: viewport.height - y - height,
            width,
            height
          });
        }

        setHighlightRects(rects);
      } catch {
        if (!cancelled) setError("Could not render PDF preview.");
      }
    };

    void render();
    return () => {
      cancelled = true;
    };
  }, [currentPage, highlightLines, pdfDoc, scale]);

  if (loading) {
    return <div className="rounded-md border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">Loading PDF preview...</div>;
  }

  if (error) {
    return <div className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">{error}</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-2 text-xs">
        <Button type="button" variant="ghost" onClick={() => setScale((prev) => Math.max(0.9, Number((prev - 0.1).toFixed(1))))}>-</Button>
        <span className="text-slate-600">{Math.round(scale * 100)}%</span>
        <Button type="button" variant="ghost" onClick={() => setScale((prev) => Math.min(2, Number((prev + 0.1).toFixed(1))))}>+</Button>
        <Button type="button" variant="ghost" onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}>Prev</Button>
        <span className="text-slate-600">{currentPage}/{pageCount || 1}</span>
        <Button type="button" variant="ghost" onClick={() => setCurrentPage((prev) => Math.min(pageCount || 1, prev + 1))}>Next</Button>
      </div>
      <div className="relative overflow-auto rounded-md border border-slate-200 bg-white">
        <canvas ref={canvasRef} className="block" />
        <div className="pointer-events-none absolute inset-0">
          {highlightRects.map((rect) => (
            <div
              key={rect.id}
              style={{
                position: "absolute",
                left: `${rect.left}px`,
                top: `${rect.top}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
                backgroundColor: "rgba(34, 197, 94, 0.30)",
                borderRadius: "2px"
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function toInternetJobRecord(job: InternetJobItem): DashboardJobRecord {
  return {
    id: `internet-${job.id}`,
    role: job.title,
    company: job.company,
    requirements: [
      `Location: ${job.location || "Not specified"}`,
      `Source: ${job.source}`
    ],
    description: `Live listing imported from ${job.source} on ${new Date(job.fetchedAt).toLocaleString()}.`,
    url: job.url,
    source: "internet"
  };
}

function toHistoryJobRecord(item: JobHistoryItem): DashboardJobRecord {
  return {
    id: `history-${item.id}`,
    role: item.targetRole,
    company: safeCompanyHost(item.jobUrl),
    requirements: [
      `Current step: ${normalizeStepLabel(item.currentStep)}`,
      `Updated: ${new Date(item.updatedAt).toLocaleString()}`
    ],
    description: `Previous application run with status ${item.status}.`,
    url: item.jobUrl,
    source: "history",
    status: item.status
  };
}

function buildAnalyzeJobDescription(job: DashboardJobRecord | null, targetRole: string, jobUrl: string): string {
  const base = [
    `Role: ${job?.role || targetRole}.`,
    `Company: ${job?.company || "Unknown company"}.`,
    `Job posting URL: ${jobUrl}.`,
    job?.description ? `Description: ${job.description}.` : ""
  ].filter(Boolean).join(" ");

  const requirementText = job?.requirements.length ? `Requirements: ${job.requirements.join("; ")}.` : "";
  const fallback = "Responsibilities include collaborating across teams, building production systems, shipping features, and owning delivery quality and communication.";
  const description = `${base} ${requirementText} ${fallback}`.trim();

  if (description.length >= 50) return description;
  return `${description} The role expects strong execution, communication, and measurable project outcomes.`;
}

function buildResumeDiffFromAnalysis(analysis: AnalyzeJobResponse, fallbackDiff: ResumeDiffLine[]): ResumeDiffLine[] {
  const matched = analysis.analysis.matched_skills.slice(0, 3);
  const missing = analysis.analysis.missing_skills.slice(0, 3);
  if (!matched.length && !missing.length) return fallbackDiff;

  const lines: ResumeDiffLine[] = [];

  if (matched[0]) {
    lines.push({
      before: "Resume bullet is generic and misses role-specific impact.",
      after: `Resume bullet now highlights ${matched[0]} with measurable outcomes tied to this role.`,
      injectedKeywords: [matched[0]]
    });
  }

  if (matched[1]) {
    lines.push({
      before: "Experience section lacks clear technology context.",
      after: `Experience section is rewritten to foreground ${matched[1]} in production delivery.`,
      injectedKeywords: [matched[1]]
    });
  }

  if (missing[0]) {
    lines.push({
      before: "No signal for an important requirement.",
      after: `Added transferable evidence for ${missing[0]} while avoiding unsupported claims.`,
      injectedKeywords: [missing[0]]
    });
  }

  return lines.length ? lines : fallbackDiff;
}

function extractLatestResumeOptimization(events: EventLog[]): ResumeOptimizationPayload | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.step !== "resume_optimized") continue;

    const payload = event.payloadJson ?? {};

    const diff = Array.isArray(payload.diff) ? payload.diff : [];
    const resumeCanonical = payload.resumeCanonical as ResumeCanonical | undefined;
    const originalResume = typeof payload.originalResume === "string" ? payload.originalResume : "";
    const version = typeof payload.version === "number" ? payload.version : 0;

    const tailoringError = typeof payload.tailoringError === "string"
      ? payload.tailoringError
      : typeof payload.error === "string"
        ? payload.error
        : undefined;
    const tailoringTriggered = Boolean(payload.tailoringTriggered);
    const fallbackUsed = Boolean(payload.fallbackUsed || tailoringError);
    const threshold = typeof payload.threshold === "number" ? payload.threshold : 70;

    return {
      resumeCanonical,
      originalResume,
      version,
      diff,
      tailoringTriggered,
      fallbackUsed,
      tailoringError,
      threshold
    };
  }

  return null;
}

function buildResumeDiffFromPayload(payload: ResumeOptimizationPayload): ResumeDiffLine[] {
  const beforeLines = payload.originalResume.split(/\r?\n/);
  const canonicalText = isValidResumeCanonical(payload.resumeCanonical)
    ? buildResumeCanonical(payload.resumeCanonical)
    : payload.originalResume;
  const canonicalLines = canonicalText.split(/\r?\n/);
  const max = Math.max(beforeLines.length, canonicalLines.length);
  const lines: ResumeDiffLine[] = [];
  const injectedSkills = Array.isArray(payload.resumeCanonical?.keywordsInjected)
    ? payload.resumeCanonical.keywordsInjected
    : [];

  for (let i = 0; i < max; i += 1) {
    const before = beforeLines[i] ?? "";
    const canonical = canonicalLines[i] ?? "";
    if (before === canonical) continue;

    const loweredCanonical = canonical.toLowerCase();
    const injectedKeywords = injectedSkills.filter((skill: string) => loweredCanonical.includes(skill.toLowerCase()));
    lines.push({ before, after: canonical, injectedKeywords });
  }

  return lines;
}

function buildApprovalAnswers(params: {
  analysis: AnalyzeJobResponse | null;
  profile: UserProfile;
  targetRole: string;
}): Array<{ prompt: string; answer: string }> {
  const company = params.analysis?.job.company || "this company";
  const role = params.analysis?.job.title || params.targetRole || "this role";
  const topSkills = params.analysis?.analysis.matched_skills.slice(0, 2) ?? [];
  const resumeSignal = params.profile.resumeText?.trim() ? "uploaded resume" : "profile details";

  return [
    {
      prompt: "Why do you want to join this company?",
      answer:
        params.profile.whyCompany?.trim() ||
        `I want to join ${company} because the ${role} scope aligns with my ${resumeSignal} and the impact I have delivered in similar environments.`
    },
    {
      prompt: "How many years of experience do you have?",
      answer: `${params.profile.yearsExperience || "3"} years in modern frontend engineering.`
    },
    {
      prompt: "What makes you a strong fit for this role?",
      answer: topSkills.length
        ? `My background maps well to this role through ${topSkills.join(" and ")}, with hands-on delivery from the projects in my uploaded resume.`
        : "My profile and uploaded resume show end-to-end ownership, cross-functional delivery, and measurable execution outcomes."
    }
  ];
}

const FIT_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "you", "your", "our", "are", "not", "will", "have",
  "has", "job", "role", "team", "work", "using", "into", "their", "they", "them", "but", "all", "can", "who",
  "what", "when", "where", "how", "why", "about", "across", "into", "over", "under", "per", "via", "too",
  "any", "out", "one", "two", "three", "four", "five", "new", "now", "yet"
]);

const SKILL_ALIASES: Record<string, string> = {
  js: "javascript",
  node: "nodejs",
  reactjs: "react",
  ml: "machine_learning",
  ai: "artificial_intelligence",
  ts: "typescript"
};

const STAGE_A_ALIASES: Record<string, string> = {
  "machine learning": "machine_learning",
  "data science": "data_science",
  "computer vision": "computer_vision",
  "natural language processing": "natural_language_processing",
  "deep learning": "deep_learning",
  "artificial intelligence": "artificial_intelligence",
  js: "javascript",
  node: "nodejs",
  reactjs: "react",
  ml: "machine_learning",
  ai: "artificial_intelligence",
  ts: "typescript"
};

const MULTI_WORD_SKILLS = [
  "machine learning",
  "data science",
  "computer vision",
  "natural language processing",
  "deep learning"
];

const ROLE_TERMS = new Set([
  "frontend", "backend", "fullstack", "engineer", "developer", "architect", "manager", "lead",
  "principal", "staff", "platform", "devops", "product", "data"
]);

const KNOWN_SKILL_TERMS = new Set([
  "javascript", "typescript", "nodejs", "react", "python", "java", "go", "rust", "graphql", "postgresql",
  "mongodb", "redis", "kubernetes", "docker", "aws", "gcp", "azure", "tensorflow", "pytorch", "langchain",
  "machine", "learning", "artificial", "intelligence", "nextjs", "nestjs", "vue", "angular", "fastapi",
  "machine_learning", "data_science", "computer_vision", "natural_language_processing", "deep_learning", "artificial_intelligence"
]);

const SKILL_FAMILIES: Record<string, string[]> = {
  frontend: ["react", "angular", "vue"],
  backend: ["nodejs", "spring", "django", "express"],
  cloud: ["aws", "gcp", "azure"],
  ml: ["machine_learning", "deep_learning", "tensorflow", "pytorch"],
  data: ["sql", "postgres", "mongodb"],
};

function getSkillFamily(skill: string): string | null {
  for (const [family, skills] of Object.entries(SKILL_FAMILIES)) {
    if (skills.includes(skill)) return family;
  }
  return null;
}

function getSkillMatchScore(jobSkill: string, userSkills: string[]): number {
  if (userSkills.includes(jobSkill)) return 1.0;

  const jobFamily = getSkillFamily(jobSkill);
  if (!jobFamily) return 0;

  for (const userSkill of userSkills) {
    if (getSkillFamily(userSkill) === jobFamily) {
      return 0.6;
    }
  }

  return 0;
}

function preprocessMultiWordSkills(text: string): string {
  let result = text.toLowerCase();
  const aliasEntries = Object.entries(STAGE_A_ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of aliasEntries) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "g");
    result = result.replace(regex, to);
  }
  for (const phrase of MULTI_WORD_SKILLS) {
    result = result.replaceAll(phrase, phrase.replace(/\s+/g, "_"));
  }
  return result;
}

function stemToken(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

function normalizeToken(token: string): string[] {
  const alias = SKILL_ALIASES[token] ?? token;
  return alias
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map(stemToken)
    .filter((segment) => segment.length >= 3 && !FIT_STOP_WORDS.has(segment));
}

function tokenizeFitTerms(text: string): string[] {
  const preprocessed = preprocessMultiWordSkills(text);
  return preprocessed
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .flatMap((token) => normalizeToken(token));
}

function getTermWeight(term: string, jobSkillTerms: Set<string>): number {
  const classification =
    (jobSkillTerms.has(term) || KNOWN_SKILL_TERMS.has(term))
      ? "SKILL"
      : ROLE_TERMS.has(term)
        ? "ROLE"
        : "GENERIC";

  if (classification === "SKILL") return 2.0;
  if (classification === "ROLE") return 1.5;
  return 1.0;
}

function computeResumeFitScore(job: DashboardJobRecord, profile: UserProfile): number {
  const resumeCorpusText = [
    profile.resumeText ?? "",
    (profile.skills ?? []).map((skill) => skill.name).join(" "),
    (profile.roles?.desiredRoles ?? []).join(" ")
  ].join(" ");

  const resumeCorpusTerms = new Set(tokenizeFitTerms(resumeCorpusText));
  if (resumeCorpusTerms.size === 0) return 0;

  const userSkillTerms = new Set(
    (profile.skills ?? []).flatMap((skill) => tokenizeFitTerms(skill.name))
  );

  const jobText = [
    job.role,
    job.company,
    job.description,
    job.requirements.join(" ")
  ].join(" ");

  const rawJobTerms = tokenizeFitTerms(jobText);
  const termFrequency = new Map<string, number>();
  for (const term of rawJobTerms) {
    termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
  }

  const normalizedTerms = rawJobTerms.slice(0, 120);
  const uniqueTerms = Array.from(new Set(normalizedTerms));
  const jobTerms = uniqueTerms.slice(0, 80);
  if (!jobTerms.length) return 0;

  const profileTextTerms = new Set(tokenizeFitTerms(profile.resumeText ?? ""));
  const userSkillsForMatching = Array.from(new Set([...userSkillTerms, ...profileTextTerms]));

  const jobSkillTerms = new Set(
    jobTerms.filter((term) => KNOWN_SKILL_TERMS.has(term))
  );

  const totalWeightedTermMass = jobTerms.reduce((sum, term) => sum + getTermWeight(term, jobSkillTerms), 0);
  const matchedWeightedTermMass = jobTerms.reduce((sum, term) => {
    if (!resumeCorpusTerms.has(term)) return sum;
    return sum + getTermWeight(term, jobSkillTerms);
  }, 0);
  const weightedCoverage = totalWeightedTermMass > 0 ? matchedWeightedTermMass / totalWeightedTermMass : 0;

  const criticalJobSkills = [...jobSkillTerms]
    .sort((a, b) => (termFrequency.get(b) ?? 0) - (termFrequency.get(a) ?? 0))
    .slice(0, 10);

  const totalMatchScore = criticalJobSkills.reduce((sum, term) => {
    return sum + getSkillMatchScore(term, userSkillsForMatching);
  }, 0);

  const totalJobSkills = criticalJobSkills.length;
  const skillCoverage = totalJobSkills > 0 ? (totalMatchScore / totalJobSkills) : weightedCoverage;

  let finalScore = (0.65 * weightedCoverage) + (0.35 * skillCoverage);

  if (totalJobSkills > 0) {
    const missingRatio = (totalJobSkills - totalMatchScore) / totalJobSkills;
    const confidenceFactor = totalJobSkills >= 5 ? 1 : 0.5;
    const penalty = 0.3 * missingRatio * confidenceFactor;
    finalScore -= penalty;
  }

  const clamped = Math.max(0, Math.min(1, finalScore));
  return Math.max(0, Math.min(100, Math.round(clamped * 100)));
}

function MainDashboardScreenInner({ user, profile, onEditProfile, onLogout }: MainDashboardScreenProps) {
  const { pushToast } = useToast();
  const [activeItem, setActiveItem] = useState<DashboardNavItem>("Apply");
  const [jobUrl, setJobUrl] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [applyMode, setApplyMode] = useState<ApplyMode>("assist");
  const [autoSubmit, setAutoSubmit] = useState(false);
  const [pauseOnLowConfidence, setPauseOnLowConfidence] = useState(true);
  const [pauseOnLongAnswers, setPauseOnLongAnswers] = useState(true);
  const [runData, setRunData] = useState<AppData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [livePreviewUrl, setLivePreviewUrl] = useState("");
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [jobSearch, setJobSearch] = useState("");
  const [jobHistory, setJobHistory] = useState<JobHistoryItem[]>([]);
  const [internetJobs, setInternetJobs] = useState<InternetJobItem[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string>("");
  const [selectedJob, setSelectedJob] = useState<DashboardJobRecord | null>(null);
  const [analysisPreview, setAnalysisPreview] = useState<AnalyzeJobResponse | null>(null);
  const [analysisPreviewKey, setAnalysisPreviewKey] = useState("");
  const [applicationsRefreshing, setApplicationsRefreshing] = useState(false);
  const [selectedApplicationRunId, setSelectedApplicationRunId] = useState("");
  const [applicationOpeningId, setApplicationOpeningId] = useState("");
  const [pipelineStageOverrideByRun, setPipelineStageOverrideByRun] = useState<Record<string, number>>({});
  const [hasUpgraded, setHasUpgraded] = useState(false);
  const [jobsMeta, setJobsMeta] = useState<{ scanned: number; fetched: number; fromCache: boolean }>({
    scanned: 0,
    fetched: 0,
    fromCache: false
  });

  const previewPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentInputKey = useMemo(
    () => `${jobUrl.trim().toLowerCase()}::${targetRole.trim().toLowerCase()}`,
    [jobUrl, targetRole]
  );
  const activeAnalysis = analysisPreviewKey === currentInputKey ? analysisPreview : null;

  const fallbackMatchedSkills = useMemo(
    () => (profile.skills ?? []).map((skill) => skill.name).filter(Boolean).slice(0, 5),
    [profile.skills]
  );
  const fallbackMissingSkills = useMemo(() => ["System Design", "GraphQL", "A/B Testing"], []);

  const matchedSkills = useMemo(
    () => activeAnalysis?.analysis.matched_skills ?? fallbackMatchedSkills,
    [activeAnalysis, fallbackMatchedSkills]
  );
  const missingSkills = useMemo(
    () => activeAnalysis?.analysis.missing_skills ?? fallbackMissingSkills,
    [activeAnalysis, fallbackMissingSkills]
  );
  const matchScore = useMemo(() => {
    if (activeAnalysis) {
      if (typeof activeAnalysis.analysis.match_score === "number") {
        return Math.max(0, Math.min(100, Math.round(activeAnalysis.analysis.match_score)));
      }
      return deriveMatchScore(targetRole, matchedSkills.length);
    }
    return deriveMatchScore(targetRole, matchedSkills.length);
  }, [activeAnalysis, matchedSkills.length, targetRole]);
  const decision = useMemo(() => {
    if (activeAnalysis) return activeAnalysis.analysis.decision;
    return inferDecision(matchScore);
  }, [activeAnalysis, matchScore]);
  const scoringSummary = useMemo(() => {
    if (activeAnalysis) {
      const normalized = Math.max(0, Math.min(1, (activeAnalysis.analysis.score ?? 0) / 100));
      const summaryDecision =
        activeAnalysis.analysis.decision === "APPLY" ? "auto_apply" :
        activeAnalysis.analysis.decision === "RISKY" ? "review" : "skip";

      const reasons = [
        ...activeAnalysis.analysis.matched_skills.slice(0, 2).map((skill) => `Matched skill: ${skill}`),
        ...activeAnalysis.analysis.risk_flags.slice(0, 2).map((flag) => `Risk: ${flag}`)
      ];

      return {
        score: normalized,
        decision: summaryDecision as "auto_apply" | "review" | "skip",
        reasons: reasons.length ? reasons : ["Analysis generated from profile and resume"]
      };
    }

    const normalized = Math.max(0, Math.min(1, matchScore / 100));
    const scoringDecision =
      normalized >= 0.75 ? "auto_apply" :
      normalized >= 0.5 ? "review" : "skip";

    const reasons: string[] = [];
    if (matchedSkills.length >= 3) reasons.push("Strong skill match");
    else if (matchedSkills.length === 0) reasons.push("Low skill match");

    if (missingSkills.length <= 1) reasons.push("Good keyword overlap");
    else reasons.push("Some skill gaps detected");

    if (!targetRole.trim()) reasons.push("Role not specified yet");

    return {
      score: normalized,
      decision: scoringDecision as "auto_apply" | "review" | "skip",
      reasons
    };
  }, [activeAnalysis, matchScore, matchedSkills.length, missingSkills.length, targetRole]);
  const latestResumeOptimization = useMemo(() => {
    return extractLatestResumeOptimization(runData?.events ?? []);
  }, [runData?.events]);
  const isValidCanonical = useMemo(
    () => isValidResumeCanonical(latestResumeOptimization?.resumeCanonical),
    [latestResumeOptimization?.resumeCanonical]
  );
  const canonicalReady = isValidCanonical;
  const resumeDiff = useMemo(() => {
    const fallbackDiff = getResumeDiff(matchedSkills);
    if (latestResumeOptimization) {
      const workerDiff = buildResumeDiffFromPayload(latestResumeOptimization);
      return workerDiff.length > 0 ? workerDiff : fallbackDiff;
    }
    if (!activeAnalysis) return fallbackDiff;
    return buildResumeDiffFromAnalysis(activeAnalysis, fallbackDiff);
  }, [activeAnalysis, latestResumeOptimization, matchedSkills]);
  const resumePreviewPdf = useMemo(() => getStoredResumePdf(), [runData?.id]);
  const syncedResumeDiff = useMemo(() => (canonicalReady ? resumeDiff : []), [canonicalReady, resumeDiff]);
  const resumeChangedLines = useMemo(() => {
    const lines = syncedResumeDiff
      .filter((line) => line.after.trim().length > 0 && line.after !== line.before)
      .map((line) => line.after.trim())
      .map((line) => line.length > 180 ? `${line.slice(0, 177)}...` : line)
      .filter((line) => line.length > 0)
      .slice(0, 8);
    return Array.from(new Set(lines));
  }, [syncedResumeDiff]);
  const resumeImprovementItems = useMemo(() => {
    const items: string[] = [];
    const addedLineCount = syncedResumeDiff.filter((line) => line.after.trim().length > 0 && line.after !== line.before).length;

    const injectedSkills = latestResumeOptimization?.resumeCanonical?.keywordsInjected ?? [];
    if (injectedSkills.length) {
      items.push(`Injected missing skills: ${injectedSkills.slice(0, 3).join(", ")}`);
    }
    if (addedLineCount > 0) {
      items.push(`${addedLineCount} resume lines improved for role relevance.`);
    }
    if (matchedSkills.length > 0) {
      items.push(`Strengthened alignment for ${matchedSkills.slice(0, 2).join(" and ")}.`);
    }
    if (items.length === 0) {
      items.push("Resume content aligned to the selected role.");
    }

    return items.slice(0, 3);
  }, [latestResumeOptimization, matchedSkills, syncedResumeDiff]);
  const generatedAnswers = useMemo(
    () => buildApprovalAnswers({ analysis: activeAnalysis, profile, targetRole }),
    [activeAnalysis, profile, targetRole]
  );

  const eventPreviewUrl = useMemo(() => {
    const events = runData?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const payload = events[i].payloadJson;
      const url = payload?.screenshotUrl;
      if (url && typeof url === "string") return url;
    }
    return "";
  }, [runData]);

  const latestPreview = livePreviewUrl || eventPreviewUrl;

  const upsertJobHistory = useCallback((details: AppData) => {
    setJobHistory((previous) => {
      const nextItem: JobHistoryItem = {
        id: details.id,
        jobUrl: details.jobUrl,
        targetRole: details.targetRole || "Untitled role",
        status: details.status,
        currentStep: details.currentStep,
        updatedAt: new Date().toISOString()
      };

      const withoutCurrent = previous.filter((item) => item.id !== details.id);
      const next = [nextItem, ...withoutCurrent].slice(0, 30);
      writeJobHistoryToStorage(next);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!applicationId) return;
    const details = await getApplication(applicationId);
    setRunData(details);
    upsertJobHistory(details);
  }, [applicationId, upsertJobHistory]);

  useEffect(() => {
    setJobHistory(readJobHistoryFromStorage());
  }, []);

  useEffect(() => {
    if (selectedApplicationRunId) return;
    if (!jobHistory.length) return;

    const active = jobHistory.filter((item) => isActiveApplicationStatus(item.status));
    const source = active.length > 0 ? active : jobHistory;
    setSelectedApplicationRunId(source[0].id);
  }, [jobHistory, selectedApplicationRunId]);

  useEffect(() => {
    if (!applicationId) {
      setLivePreviewUrl("");
      if (previewPollRef.current) {
        clearInterval(previewPollRef.current);
        previewPollRef.current = null;
      }
      return;
    }

    previewPollRef.current = setInterval(() => {
      void getLatestPreview(applicationId).then((url) => {
        if (url) setLivePreviewUrl(`${url}?t=${Date.now()}`);
      });
    }, 2000);

    const unsub = subscribeToApplication(applicationId, () => {
      void refresh();
    });

    const interval = window.setInterval(() => {
      void refresh();
    }, 6000);

    return () => {
      unsub();
      clearInterval(interval);
      if (previewPollRef.current) {
        clearInterval(previewPollRef.current);
        previewPollRef.current = null;
      }
    };
  }, [applicationId, refresh]);

  const createPayload = useMemo(
    () => ({
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
        "why-this-company": profile.whyCompany || "I am excited about this opportunity.",
        "years-experience": profile.yearsExperience || "0"
      },
      automationPolicy: {
        mode: applyMode,
        autoSubmit,
        pauseOnLowConfidence,
        pauseOnLongAnswers
      }
    }),
    [applyMode, autoSubmit, pauseOnLongAnswers, pauseOnLowConfidence, profile]
  );

  const startApplication = useCallback(async () => {
    if (!jobUrl || !targetRole) return;
    setError("");
    setLoading(true);
    try {
      const created = await createApplication({
        jobUrl,
        targetRole,
        metadata: createPayload
      });
      setApplicationId(created.applicationId);
      const details = await getApplication(created.applicationId);
      setRunData(details);
      upsertJobHistory(details);
      pushToast({
        title: "Automation started",
        description: "Application run is now live.",
        tone: "success"
      });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Failed to start application";
      setError(msg);
      pushToast({ title: "Failed", description: msg, tone: "danger" });
    } finally {
      setLoading(false);
    }
  }, [createPayload, jobUrl, pushToast, targetRole, upsertJobHistory]);

  const handleApproval = useCallback(() => {
    setApprovalOpen(false);
    void startApplication();
  }, [startApplication]);

  const handlePause = useCallback(async () => {
    if (!applicationId) return;
    await pauseApplication(applicationId);
    await refresh();
    pushToast({ title: "Paused", description: "Automation paused.", tone: "accent" });
  }, [applicationId, pushToast, refresh]);

  const handleResume = useCallback(async () => {
    if (!applicationId) return;
    await resumeApplication(applicationId);
    await refresh();
    pushToast({ title: "Resumed", description: "Automation resumed.", tone: "success" });
  }, [applicationId, pushToast, refresh]);

  const pipelineSteps = mapPipelineSteps(runData?.currentStep ?? "");
  const logs = mapLogs(runData?.events ?? []);
  const completedEventCount = useMemo(
    () => (runData?.events ?? []).filter((event) => event.step.toLowerCase().includes("submitted")).length,
    [runData?.events]
  );

  const filteredJobs = useMemo(() => {
    const query = jobSearch.trim().toLowerCase();
    if (!query) return jobHistory;

    return jobHistory.filter((item) => {
      return (
        item.targetRole.toLowerCase().includes(query) ||
        safeCompanyHost(item.jobUrl).toLowerCase().includes(query) ||
        item.jobUrl.toLowerCase().includes(query)
      );
    });
  }, [jobHistory, jobSearch]);

  const allJobs = useMemo<DashboardJobRecord[]>(() => {
    const query = jobSearch.trim().toLowerCase();

    const internetRecords: DashboardJobRecord[] = internetJobs.map(toInternetJobRecord);
    const historyRecords: DashboardJobRecord[] = filteredJobs.map(toHistoryJobRecord);

    const merged = [...internetRecords, ...historyRecords];

    if (!query) return merged;
    return merged.filter((job) => {
      return (
        job.role.toLowerCase().includes(query) ||
        job.company.toLowerCase().includes(query) ||
        job.url.toLowerCase().includes(query)
      );
    });
  }, [filteredJobs, internetJobs, jobSearch]);

  const resumeFitByJobId = useMemo(() => {
    const entries = allJobs.map((job) => [job.id, computeResumeFitScore(job, profile)] as const);
    return new Map<string, number>(entries);
  }, [allJobs, profile]);

  const currentApplications = useMemo(() => {
    const active = jobHistory.filter((item) => isActiveApplicationStatus(item.status));
    return active.length > 0 ? active : jobHistory;
  }, [jobHistory]);

  const selectedApplicationItem = useMemo(() => {
    if (!selectedApplicationRunId) return currentApplications[0] ?? null;
    return currentApplications.find((item) => item.id === selectedApplicationRunId) ?? currentApplications[0] ?? null;
  }, [currentApplications, selectedApplicationRunId]);

  const selectedApplicationRun = useMemo(() => {
    if (!selectedApplicationItem) return null;
    if (runData && runData.id === selectedApplicationItem.id) return runData;
    return null;
  }, [runData, selectedApplicationItem]);

  const backendPipelineIndex = useMemo(() => {
    if (!selectedApplicationItem) return 0;
    return mapBackendStepToPipelineIndex(
      selectedApplicationRun?.currentStep ?? selectedApplicationItem.currentStep,
      selectedApplicationRun?.status ?? selectedApplicationItem.status
    );
  }, [selectedApplicationItem, selectedApplicationRun]);

  const isTerminalApplicationRun = useMemo(() => {
    if (!selectedApplicationItem) return false;
    const status = (selectedApplicationRun?.status ?? selectedApplicationItem.status ?? "").toLowerCase();
    return (
      status.includes("submitted") ||
      status.includes("completed") ||
      status.includes("success") ||
      status.includes("failed") ||
      status.includes("cancelled")
    );
  }, [selectedApplicationItem, selectedApplicationRun]);

  const activePipelineIndex = useMemo(() => {
    if (!selectedApplicationItem) return 0;
    const override = pipelineStageOverrideByRun[selectedApplicationItem.id];

    // For active runs, stay at Resume unless user explicitly continues.
    if (!isTerminalApplicationRun) {
      if (typeof override === "number") {
        return Math.max(0, Math.min(5, override));
      }
      if (backendPipelineIndex <= 1) return backendPipelineIndex;
      return 1;
    }

    if (typeof override === "number") {
      return Math.max(backendPipelineIndex, override);
    }

    return backendPipelineIndex;
  }, [backendPipelineIndex, isTerminalApplicationRun, pipelineStageOverrideByRun, selectedApplicationItem]);
  const activePipelineStage = APPLICATION_PIPELINE[activePipelineIndex]?.key ?? "optimize";

  const resumePreviewState = useMemo(() => {
    const originalText = latestResumeOptimization?.originalResume || profile.resumeText || "";
    const canonicalData = canonicalReady && latestResumeOptimization?.resumeCanonical
      ? latestResumeOptimization.resumeCanonical
      : undefined;
    const hasDiff = Boolean(canonicalReady && (latestResumeOptimization?.diff?.length || syncedResumeDiff.length));
    const resumeType = canonicalReady ? "Optimized Resume" : "Original Resume";
    const showLoading = !canonicalData && !originalText.trim();

    return {
      canonicalData,
      originalText,
      resumeType,
      showLoading,
      hasDiff,
      canonicalReady
    };
  }, [canonicalReady, latestResumeOptimization, profile.resumeText, syncedResumeDiff.length]);
  const resumePreviewLinks = useMemo(() => {
    const values = [
      profile.links?.linkedin || profile.linkedIn || "",
      profile.links?.github || "",
      profile.links?.portfolio || profile.portfolio || "",
      profile.links?.other || ""
    ].map((value) => value.trim()).filter(Boolean);
    return values.join(" | ");
  }, [profile.linkedIn, profile.links?.github, profile.links?.linkedin, profile.links?.other, profile.links?.portfolio, profile.portfolio]);

  useEffect(() => {
    setHasUpgraded(false);
  }, [selectedApplicationItem?.id]);

  useEffect(() => {
    if (canonicalReady) {
      setHasUpgraded(true);
    }
  }, [canonicalReady]);

  useEffect(() => {
    if (!latestResumeOptimization?.resumeCanonical || canonicalReady) return;
    console.warn("Invalid canonical detected, falling back to original");
  }, [canonicalReady, latestResumeOptimization?.resumeCanonical]);

  useEffect(() => {
    if (activePipelineStage !== "resume") return;

    console.table({
      stage: activePipelineStage,
      canonicalReady,
      originalReady: Boolean((latestResumeOptimization?.originalResume || profile.resumeText || "").trim()),
      diffReady: resumePreviewState.hasDiff,
      upgraded: hasUpgraded
    });
  }, [activePipelineStage, canonicalReady, hasUpgraded, latestResumeOptimization, profile.resumeText, resumePreviewState.hasDiff]);

  const automationConfidence = useMemo(() => {
    if (!selectedApplicationRun) return 0;
    const eventCount = selectedApplicationRun.events?.length ?? 0;
    const score = Math.min(95, 55 + eventCount * 4);
    return Math.max(0, Math.round(score));
  }, [selectedApplicationRun]);

  const selectedInputJob = useMemo<DashboardJobRecord | null>(() => {
    const normalizedUrl = jobUrl.trim().toLowerCase();
    if (!normalizedUrl) return null;

    const internetMatch = internetJobs.find((job) => job.url.trim().toLowerCase() === normalizedUrl);
    if (internetMatch) return toInternetJobRecord(internetMatch);

    const historyMatch = jobHistory.find((item) => item.jobUrl.trim().toLowerCase() === normalizedUrl);
    if (historyMatch) return toHistoryJobRecord(historyMatch);

    return null;
  }, [internetJobs, jobHistory, jobUrl]);

  const handleAnalyzeBeforeApproval = useCallback(async () => {
    if (!jobUrl || !targetRole) return;

    setError("");
    setLoading(true);

    try {
      const analysisResponse = await analyzeJob({
        jobDescription: buildAnalyzeJobDescription(selectedInputJob, targetRole, jobUrl),
        companyName: selectedInputJob?.company,
        jobTitle: selectedInputJob?.role || targetRole,
        profileText: profile.resumeText,
        profileSkills: (profile.skills ?? []).map((skill) => skill.name).filter(Boolean)
      });

      setAnalysisPreview(analysisResponse);
      setAnalysisPreviewKey(currentInputKey);
      setApprovalOpen(true);
    } catch (err: unknown) {
      setAnalysisPreview(null);
      setAnalysisPreviewKey("");
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Could not run job analysis preview. Showing fallback preview.";
      pushToast({ title: "Analysis fallback", description: message, tone: "accent" });
      setApprovalOpen(true);
    } finally {
      setLoading(false);
    }
  }, [currentInputKey, jobUrl, profile.resumeText, profile.skills, pushToast, selectedInputJob, targetRole]);

  const openJobDetails = useCallback((job: DashboardJobRecord) => {
    setSelectedJob(job);
  }, []);

  const handleApplyFromJob = useCallback((job: DashboardJobRecord) => {
    const start = async () => {
      setSelectedJob(null);
      setError("");
      setLoading(true);
      try {
        const created = await createApplication({
          jobUrl: job.url,
          targetRole: job.role,
          metadata: createPayload
        });

        const details = await getApplication(created.applicationId);
        setApplicationId(created.applicationId);
        setRunData(details);
        upsertJobHistory(details);
        setSelectedApplicationRunId(created.applicationId);

        setJobUrl(job.url);
        setTargetRole(job.role);
        setActiveItem("Applications");

        pushToast({
          title: "Application started",
          description: `${job.role} at ${job.company} is now running in background.`,
          tone: "success"
        });
      } catch (err: unknown) {
        const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Failed to start application from job card.";
        setError(message);
        pushToast({ title: "Failed", description: message, tone: "danger" });
      } finally {
        setLoading(false);
      }
    };

    void start();
  }, [createPayload, pushToast, upsertJobHistory]);

  const refreshApplications = useCallback(async () => {
    if (jobHistory.length === 0) return;

    setApplicationsRefreshing(true);
    try {
      const ids = jobHistory.map((item) => item.id);
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            return await getApplication(id);
          } catch {
            return null;
          }
        })
      );

      const valid = results.filter((item): item is AppData => !!item);
      if (valid.length === 0) return;

      setJobHistory((previous) => {
        const merged = new Map(previous.map((item) => [item.id, item]));

        valid.forEach((details) => {
          merged.set(details.id, {
            id: details.id,
            jobUrl: details.jobUrl,
            targetRole: details.targetRole || "Untitled role",
            status: details.status,
            currentStep: details.currentStep,
            updatedAt: new Date().toISOString()
          });
        });

        const next = Array.from(merged.values())
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          .slice(0, 30);

        writeJobHistoryToStorage(next);
        return next;
      });
    } finally {
      setApplicationsRefreshing(false);
    }
  }, [jobHistory]);

  const openApplicationRun = useCallback(async (item: JobHistoryItem) => {
    setApplicationOpeningId(item.id);
    setSelectedApplicationRunId(item.id);
    setApplicationId(item.id);
    setJobUrl(item.jobUrl);
    setTargetRole(item.targetRole);
    setActiveItem("ApplicationDetail");
    setRunData((previous) => {
      if (previous && previous.id === item.id) return previous;
      return {
        id: item.id,
        currentStep: item.currentStep,
        status: item.status,
        jobUrl: item.jobUrl,
        targetRole: item.targetRole,
        events: []
      };
    });

    try {
      const details = await getApplication(item.id);
      setRunData(details);
      upsertJobHistory(details);
      pushToast({
        title: "Application opened",
        description: `Opened ${item.targetRole} workflow.`,
        tone: "success"
      });
    } catch {
      pushToast({ title: "Sync failed", description: "Could not load latest application details.", tone: "accent" });
    } finally {
      setApplicationOpeningId("");
    }
  }, [pushToast, upsertJobHistory]);

  const promoteApplicationPipelineStage = useCallback((runId: string, stageIndex: number) => {
    setPipelineStageOverrideByRun((previous) => {
      const current = previous[runId] ?? 0;
      return {
        ...previous,
        [runId]: Math.max(current, stageIndex)
      };
    });
  }, []);

  useEffect(() => {
    if (!selectedApplicationItem) return;
    if (!latestResumeOptimization) return;
    promoteApplicationPipelineStage(selectedApplicationItem.id, 1);
  }, [latestResumeOptimization, promoteApplicationPipelineStage, selectedApplicationItem]);

  const loadInternetJobs = useCallback(async (refresh = false) => {
    setJobsLoading(true);
    setJobsError("");
    try {
      const response = await getInternetJobs({
        query: jobSearch,
        refresh,
        limit: 120
      });
      setInternetJobs(response.jobs);
      setJobsMeta({
        scanned: response.totalScannedCompanies,
        fetched: response.totalFetchedJobs,
        fromCache: response.fromCache
      });
      if (response.errors.length > 0) {
        setJobsError(`Some sources failed (${response.errors.length}). Showing available jobs.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load internet jobs";
      setJobsError(message);
      setInternetJobs([]);
    } finally {
      setJobsLoading(false);
    }
  }, [jobSearch]);

  useEffect(() => {
    if (activeItem !== "Jobs" && activeItem !== "Apply") return;
    const timer = window.setTimeout(() => {
      void loadInternetJobs(false);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeItem, jobSearch, loadInternetJobs]);

  const jobsBoard = (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Internet Jobs</h2>
          <p className="text-sm text-slate-500">Live feed from company ATS APIs.</p>
        </div>
        <Button type="button" variant="default" onClick={() => void loadInternetJobs(true)}>
          Refresh Jobs
        </Button>
      </div>

      <Input
        value={jobSearch}
        onChange={(event) => setJobSearch(event.target.value)}
        placeholder="Search by role or company..."
      />

      {jobsError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">{jobsError}</div>
      ) : null}

      {jobsLoading ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
          Scanning company APIs for jobs...
        </div>
      ) : null}

      {!jobsLoading && allJobs.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {allJobs.map((job) => (
            <article
              key={job.id}
              className="cursor-pointer rounded-xl border border-slate-200 bg-slate-50 p-4 transition hover:border-slate-300 hover:bg-white"
              onClick={() => openJobDetails(job)}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm text-slate-500">{job.company}</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{job.role}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="accent">{job.source}</Badge>
                  <Badge tone="neutral">Quick Match {resumeFitByJobId.get(job.id) ?? 0}%</Badge>
                </div>
              </div>

              <p className="mt-2 line-clamp-2 text-xs text-slate-500">{job.description}</p>
              <p className="mt-1 line-clamp-1 text-xs text-slate-500">{job.url}</p>
            </article>
          ))}
        </div>
      ) : null}

      {!jobsLoading && allJobs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
          No jobs found yet. Try refreshing the feed.
        </div>
      ) : null}
    </div>
  );

  const leftRail =
    activeItem === "Apply" ? (
      <div className="space-y-4">
        <JobInputPanel
          jobUrl={jobUrl}
          targetRole={targetRole}
          applyMode={applyMode}
          autoSubmit={autoSubmit}
          pauseOnLowConfidence={pauseOnLowConfidence}
          pauseOnLongAnswers={pauseOnLongAnswers}
          loading={loading}
          hasApplication={!!applicationId}
          error={error}
          onJobUrlChange={setJobUrl}
          onTargetRoleChange={setTargetRole}
          onApplyModeChange={setApplyMode}
          onAutoSubmitChange={setAutoSubmit}
          onPauseOnLowConfidenceChange={setPauseOnLowConfidence}
          onPauseOnLongAnswersChange={setPauseOnLongAnswers}
          onSubmit={() => void handleAnalyzeBeforeApproval()}
        />
        {applicationId ? (
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={handlePause} variant="ghost">Pause</Button>
            <Button onClick={handleResume} variant="ghost">Resume</Button>
            <Button onClick={() => void refresh()} className="col-span-2" variant="default">Refresh run</Button>
          </div>
        ) : null}
      </div>
    ) : activeItem === "Applications" ? null : activeItem === "Jobs" ? (
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm text-slate-500">Jobs</p>
        <h2 className="text-xl font-semibold text-slate-900">Internet Job Feed</h2>
        <p className="text-sm text-slate-500">Pulled from company ATS APIs inspired by career-ops scan.</p>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Scanned {jobsMeta.scanned} sources, fetched {jobsMeta.fetched} jobs {jobsMeta.fromCache ? "(cached)" : "(live)"}
        </div>
        <div className="space-y-2 text-sm text-slate-700">
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
            <span>Current status</span>
            <span className="font-medium text-slate-900">{runData?.status ?? "idle"}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
            <span>Current step</span>
            <span className="font-medium text-slate-900">{runData?.currentStep ?? "not started"}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
            <span>Submitted events</span>
            <span className="font-medium text-slate-900">{completedEventCount}</span>
          </div>
        </div>
        <Button onClick={() => void loadInternetJobs(true)} className="w-full" variant="default">Refresh Internet Jobs</Button>
      </div>
    ) : (
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm text-slate-500">Settings</p>
        <h2 className="text-xl font-semibold text-slate-900">Account Settings</h2>
        <div className="space-y-2 text-sm text-slate-700">
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-500">Name</p>
            <p className="font-medium text-slate-900">{user.firstName} {user.lastName}</p>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-500">Email</p>
            <p className="font-medium text-slate-900">{user.email}</p>
          </div>
        </div>
        <Button onClick={onEditProfile} className="w-full" variant="default">Edit Profile Details</Button>
      </div>
    );

  const main =
    activeItem === "Apply" ? (
      <>
        {jobsBoard}
        <PipelineStepper steps={pipelineSteps} />
        <div className="grid gap-6 lg:grid-cols-2">
          <JobIntelligenceCard
            title={targetRole || "Role not set"}
            company={safeCompanyHost(runData?.jobUrl)}
            matchScore={matchScore}
            matchedSkills={matchedSkills}
            missingSkills={missingSkills}
            decision={decision}
            scoring={scoringSummary}
          />
          <ResumeDiffPreview lines={resumeDiff} />
        </div>
        <div className="grid gap-6 2xl:grid-cols-2">
          <LiveAutomationPreview
            jobUrl={jobUrl || runData?.jobUrl}
            profile={profile}
            generatedAnswers={generatedAnswers}
          />
          <ExecutionLogs logs={logs} />
        </div>
      </>
    ) : activeItem === "ApplicationDetail" ? (
      selectedApplicationItem ? (
        <div className="space-y-4">
          <div>
            <Button type="button" variant="ghost" onClick={() => setActiveItem("Applications")}>Back to Applications</Button>
          </div>
          {applicationOpeningId === selectedApplicationItem.id ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Loading latest run details...
            </div>
          ) : null}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">Application Pipeline</h2>
                <p className="text-sm text-slate-500">{selectedApplicationItem.targetRole} at {safeCompanyHost(selectedApplicationItem.jobUrl)}</p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-slate-500">{selectedApplicationRun?.status ?? selectedApplicationItem.status}</p>
                <p className="text-xs text-slate-500">{normalizeStepLabel(selectedApplicationRun?.currentStep ?? selectedApplicationItem.currentStep)}</p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-6 gap-2">
              {APPLICATION_PIPELINE.map((stage, index) => {
                const completed = index < activePipelineIndex;
                const current = index === activePipelineIndex;
                return (
                  <div key={stage.key} className="flex flex-col items-center gap-2 text-center">
                    <div
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold ${
                        completed
                          ? "bg-emerald-600 text-white"
                          : current
                            ? "bg-slate-900 text-white"
                            : "bg-slate-200 text-slate-500"
                      }`}
                    >
                      {completed ? "✓" : index + 1}
                    </div>
                    <p className={`text-xs ${current ? "font-semibold text-slate-900" : "text-slate-500"}`}>{stage.label}</p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_430px]">
            <div className="space-y-4">
              {activePipelineIndex <= 1 ? (
                <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-lg font-semibold text-slate-900">{activePipelineIndex === 0 ? "Resume Optimization" : "Resume Match"}</h3>
                  {activePipelineIndex === 0 ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center">
                      <p className="text-lg font-semibold text-slate-900">Optimizing Your Resume</p>
                      <p className="mt-2 text-sm text-slate-600">Analyzing the job description and tailoring bullet points...</p>
                      <div className="mt-4 flex items-center justify-center gap-2" aria-label="Resume optimization in progress">
                        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500" />
                        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-600 [animation-delay:120ms]" />
                        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-700 [animation-delay:240ms]" />
                      </div>
                    </div>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs text-slate-500">Profile Fit</p>
                        <p className="mt-2 text-4xl font-semibold text-slate-900">{matchScore}%</p>
                        <p className="mt-1 text-sm text-emerald-700">Good Match</p>
                        <p className="mt-2 text-xs text-slate-600">{matchedSkills.length} of {matchedSkills.length + missingSkills.length} keywords matched</p>
                      </div>
                      <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs text-slate-500">Skill Summary</p>
                        <p className="text-sm text-slate-800">Matched {matchedSkills.length}/{matchedSkills.length + missingSkills.length} required skills</p>
                        <p className="text-sm text-slate-700">Missing: {missingSkills.join(", ") || "None"}</p>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}

              {activePipelineIndex === 1 ? (
                <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-lg font-semibold text-slate-900">Resume Review</h3>
                  {backendPipelineIndex > 1 ? (
                    <p className="text-xs text-slate-500">Resume optimization is complete. Click Continue to move to cover letter generation.</p>
                  ) : null}
                  
                  {latestResumeOptimization?.tailoringTriggered && latestResumeOptimization?.fallbackUsed && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                      <strong>Tailoring Failed:</strong> {latestResumeOptimization.tailoringError || "An unexpected error occurred."}
                      <p className="mt-1 text-xs text-rose-700">Falling back to the original resume text. You must acknowledge this before continuing.</p>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Match Score</p>
                      <p className="mt-1 text-sm font-semibold text-slate-800">{matchScore}%</p>
                      <p className="text-xs text-slate-600">Threshold: {latestResumeOptimization?.threshold ?? 70}%</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Tailoring Status</p>
                      <p className="mt-1 text-xs text-slate-800">Triggered: <span className="font-semibold">{latestResumeOptimization?.tailoringTriggered ? "YES" : "NO"}</span></p>
                      <p className="text-xs text-slate-800">Fallback Used: <span className="font-semibold">{latestResumeOptimization?.fallbackUsed ? "YES" : "NO"}</span></p>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">Improvements made</p>
                    <div className="mt-2 space-y-2">
                       {latestResumeOptimization?.diff && latestResumeOptimization.diff.length > 0 ? latestResumeOptimization.diff.map((item, idx) => (
                        <div key={`resume-improvement-${idx}`} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs">
                          <p className="font-semibold text-emerald-900 capitalize">{item.section}</p>
                          <p className="text-emerald-800">{item.reason}</p>
                        </div>
                      )) : (
                        <p className="text-xs text-slate-600">No AI rewrites applied.</p>
                      )}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">Required Skills</p>
                    <p className="mt-1 text-sm text-slate-800">{matchedSkills.length} of {matchedSkills.length + missingSkills.length} matched</p>
                    <p className="mt-1 text-xs text-slate-700">Missing: {missingSkills.join(", ") || "None"}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="ghost" onClick={() => pushToast({ title: "Download started", description: "Resume download is being prepared.", tone: "accent" })}>Download</Button>
                    <Button type="button" variant="ghost" onClick={() => onEditProfile()}>Edit</Button>
                    <Button type="button" variant="ghost" onClick={() => pushToast({ title: "Default applied", description: "Using default resume template.", tone: "accent" })}>Default Resume</Button>
                    <Button
                      type="button"
                      variant="default"
                      onClick={() => promoteApplicationPipelineStage(selectedApplicationItem.id, 2)}
                    >
                      Continue
                    </Button>
                  </div>
                </div>
              ) : null}

              {activePipelineIndex === 2 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-lg font-semibold text-slate-900">Cover Letter Generation</h3>
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-8 text-center">
                    <p className="text-sm text-slate-600">Generating cover letter...</p>
                  </div>
                  <div className="mt-3">
                    <Button
                      type="button"
                      variant="default"
                      onClick={() => promoteApplicationPipelineStage(selectedApplicationItem.id, 3)}
                    >
                      Continue to Cover Letter Review
                    </Button>
                  </div>
                </div>
              ) : null}

              {activePipelineIndex === 3 ? (
                <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-lg font-semibold text-slate-900">Cover Letter Review</h3>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                    <p className="text-xs uppercase tracking-wide text-slate-500">AI Generated</p>
                    <p className="mt-2 whitespace-pre-wrap">{generatedAnswers.find((item) => item.prompt.toLowerCase().includes("why"))?.answer || profile.whyCompany || "Generated cover letter text is ready for review."}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                    <p className="font-semibold text-slate-700">Why this works</p>
                    <p className="mt-1">Connects your proof points to the role scope, highlights impact, and keeps recruiter-friendly clarity.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="ghost" onClick={() => onEditProfile()}>Edit</Button>
                    <Button type="button" variant="default" onClick={() => promoteApplicationPipelineStage(selectedApplicationItem.id, 4)}>Approve</Button>
                    <Button type="button" variant="ghost" onClick={() => promoteApplicationPipelineStage(selectedApplicationItem.id, 4)}>Skip</Button>
                  </div>
                </div>
              ) : null}

              {activePipelineIndex >= 4 ? (
                <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold text-slate-900">Automation</h3>
                    <p className="text-xs text-slate-500">{automationConfidence}% fields filled correctly</p>
                  </div>
                  <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                    {(selectedApplicationRun?.events ?? runData?.events ?? []).slice(-6).map((event) => (
                      <p key={event.id}>• {event.message || normalizeStepLabel(event.step)} ✓</p>
                    ))}
                    {((selectedApplicationRun?.events ?? runData?.events ?? []).length === 0) ? (
                      <p>• Waiting for live automation events...</p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="space-y-4">
              {activePipelineIndex === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm font-medium text-slate-900">Optimizing Resume</p>
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-16 text-center">
                    <p className="text-xl font-semibold text-slate-900">Optimizing Your Resume</p>
                    <p className="mt-2 text-sm text-slate-600">Changes will appear here as soon as optimization completes.</p>
                    <div className="mt-5 flex items-center justify-center gap-2">
                      <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500" />
                      <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-600 [animation-delay:120ms]" />
                      <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-700 [animation-delay:240ms]" />
                    </div>
                  </div>
                </div>
              ) : null}

              {activePipelineIndex === 1 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm font-medium text-slate-900">Resume Preview</p>
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-5">
                    {hasUpgraded ? <div className="mb-2 text-xs text-blue-500">Resume optimized successfully</div> : null}
                    {resumePreviewState.showLoading ? (
                      <div className="animate-pulse space-y-2 rounded-md border border-slate-200 bg-white p-4">
                        <div className="h-4 w-3/4 rounded bg-gray-200" />
                        <div className="h-4 w-5/6 rounded bg-gray-200" />
                        <div className="h-4 w-2/3 rounded bg-gray-200" />
                      </div>
                    ) : (
                      <div>
                        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">{resumePreviewState.resumeType}</p>
                        <StructuredResumePreview
                          jobId={selectedApplicationItem?.id || applicationId || "resume-preview"}
                          canonical={resumePreviewState.canonicalData}
                          originalResume={resumePreviewState.originalText}
                          missingSkills={missingSkills}
                          userName={`${user.firstName} ${user.lastName}`}
                          email={user.email}
                          phone={profile.phone || ""}
                          links={resumePreviewLinks}
                        />
                      </div>
                    )}
                    {resumePreviewPdf ? (
                      <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-4">
                        <p className="truncate text-xs text-slate-500">Generated PDF: {resumePreviewPdf.fileName}</p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => window.open(resumePreviewPdf.dataUrl, "_blank", "noopener,noreferrer")}
                        >
                          Download Optional PDF
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {resumePreviewState.canonicalReady ? (
                    <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Changed Lines (Green Highlight)</p>
                      <div className="mt-2 space-y-2">
                        {resumeChangedLines.length > 0 ? resumeChangedLines.map((item, idx) => (
                          <p key={`resume-added-${idx}`} className="rounded-md bg-emerald-100 px-2 py-1 text-xs text-emerald-900">
                            + {item}
                          </p>
                        )) : (
                          <p className="text-xs text-emerald-800">No detected additions yet.</p>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {activePipelineIndex === 2 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm font-medium text-slate-900">Cover Letter Generation</p>
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-600">
                    Generating cover letter...
                  </div>
                </div>
              ) : null}

              {activePipelineIndex === 3 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm font-medium text-slate-900">Cover Letter Preview</p>
                  <div className="mt-3 h-[540px] overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-5 text-sm leading-6 text-slate-700">
                    <p className="whitespace-pre-wrap">{generatedAnswers.find((item) => item.prompt.toLowerCase().includes("why"))?.answer || "Cover letter draft pending..."}</p>
                  </div>
                </div>
              ) : null}

              {activePipelineIndex >= 4 ? (
                <div className="relative">
                  <LiveAutomationPreview
                    jobUrl={selectedApplicationItem.jobUrl}
                    profile={profile}
                    generatedAnswers={generatedAnswers}
                  />
                  {activePipelineIndex === 4 ? (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-slate-900/35 px-4 text-center text-sm font-medium text-white">
                      Automation running. Pause to interact manually.
                    </div>
                  ) : null}
                </div>
              ) : null}

              {activePipelineIndex >= 5 ? (
                <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm font-medium text-slate-900">Final Review & Submit</p>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                    Form is filled — review before submitting.
                  </div>
                  <Button
                    type="button"
                    variant="default"
                    onClick={() => {
                      promoteApplicationPipelineStage(selectedApplicationItem.id, 5);
                      pushToast({ title: "Submit requested", description: "Final submit action is ready.", tone: "success" });
                    }}
                  >
                    Submit Application
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
          No applications started yet. Click Apply on a job card to start a background run.
        </div>
      )
    ) : activeItem === "Applications" ? (
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Applications</h2>
            <p className="text-sm text-slate-500">Select a current application to open its full pipeline page.</p>
          </div>
          <Button type="button" variant="default" onClick={() => void refreshApplications()}>
            {applicationsRefreshing ? "Refreshing..." : "Refresh"}
          </Button>
        </div>

        {currentApplications.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
            No applications started yet. Click Apply on a job card to start a background run.
          </div>
        ) : (
          <div className="space-y-3">
            {currentApplications.map((item) => (
              <article key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-sm text-slate-500">{safeCompanyHost(item.jobUrl)}</p>
                    <p className="text-lg font-semibold text-slate-900">{item.targetRole}</p>
                    <p className="text-xs text-slate-500">{item.jobUrl}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs uppercase tracking-wide text-slate-500">{item.status}</p>
                    <p className="text-xs text-slate-500">{normalizeStepLabel(item.currentStep)}</p>
                    <p className="text-xs text-slate-400">{new Date(item.updatedAt).toLocaleString()}</p>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button type="button" variant="ghost" onClick={() => window.open(item.jobUrl, "_blank", "noopener,noreferrer")}>Open Job</Button>
                  <Button type="button" variant="default" onClick={() => void openApplicationRun(item)}>Open Pipeline</Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    ) : activeItem === "Jobs" ? (
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Jobs moved to Dashboard</h2>
        <p className="text-sm text-slate-500">
          The full interactive jobs list now appears directly in Dashboard so you can review and apply from one place.
        </p>
        <Button type="button" variant="default" onClick={() => setActiveItem("Apply")}>
          Open Dashboard Jobs
        </Button>
      </div>
    ) : (
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Settings</h2>
        <p className="text-sm text-slate-500">Your profile is saved. You can review details and edit anytime.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-500">Phone</p>
            <p className="font-medium text-slate-900">{profile.phone || "Not set"}</p>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-500">Location</p>
            <p className="font-medium text-slate-900">{profile.location || "Not set"}</p>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2 sm:col-span-2">
            <p className="text-xs text-slate-500">Desired roles</p>
            <p className="font-medium text-slate-900">{(profile.roles?.desiredRoles ?? []).join(", ") || "Not set"}</p>
          </div>
        </div>
        <Button onClick={onEditProfile} variant="default">Open Full Profile</Button>
      </div>
    );

  return (
    <DashboardLayout
      sidebar={
        <DashboardSidebar
          userName={`${user.firstName} ${user.lastName}`}
          userEmail={user.email}
          activeItem={activeItem === "ApplicationDetail" ? "Applications" : activeItem}
          onNavigateApply={() => setActiveItem("Apply")}
          onNavigateApplications={() => setActiveItem("Applications")}
          onNavigateJobs={() => setActiveItem("Jobs")}
          onNavigateProfile={onEditProfile}
          onNavigateSettings={() => setActiveItem("Settings")}
          onLogout={onLogout}
        />
      }
      leftRail={activeItem === "Apply" ? null : leftRail}
      main={activeItem === "Apply" ? jobsBoard : main}
      hideLeftRail={activeItem === "ApplicationDetail" || activeItem === "Apply" || activeItem === "Applications"}
    >
      <ApprovalModal
        open={approvalOpen}
        onOpenChange={setApprovalOpen}
        score={matchScore}
        resumeDiff={resumeDiff}
        generatedAnswers={generatedAnswers}
        onApprove={handleApproval}
        onEdit={() => {
          setApprovalOpen(false);
          onEditProfile();
        }}
        onReject={() => {
          setApprovalOpen(false);
          pushToast({ title: "Rejected", description: "Application run canceled.", tone: "danger" });
        }}
      />

      <Dialog
        open={!!selectedJob}
        onOpenChange={(open) => {
          if (!open) setSelectedJob(null);
        }}
        title={selectedJob ? `${selectedJob.role} at ${selectedJob.company}` : "Job Details"}
        footer={
          selectedJob ? (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => window.open(selectedJob.url, "_blank", "noopener,noreferrer")}
              >
                Open Original Posting
              </Button>
              <Button type="button" variant="default" onClick={() => handleApplyFromJob(selectedJob)}>
                Apply
              </Button>
            </>
          ) : null
        }
      >
        {selectedJob ? (
          <>
            <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Role</p>
              <p className="text-sm font-medium text-slate-900">{selectedJob.role}</p>
            </div>

            <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Company</p>
              <p className="text-sm font-medium text-slate-900">{selectedJob.company}</p>
            </div>

            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Requirements</p>
              {selectedJob.requirements.length > 0 ? (
                selectedJob.requirements.map((requirement) => (
                  <p key={requirement} className="text-sm text-slate-800">- {requirement}</p>
                ))
              ) : (
                <p className="text-sm text-slate-600">Requirements are not available for this source yet.</p>
              )}
            </div>

            <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Description</p>
              <p className="text-sm text-slate-800">{selectedJob.description}</p>
            </div>

            <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-500">Original Posting</p>
              <p className="break-all text-sm text-slate-800">{selectedJob.url}</p>
            </div>
          </>
        ) : null}
      </Dialog>
    </DashboardLayout>
  );
}

export function MainDashboardScreen(props: MainDashboardScreenProps) {
  return (
    <ToastProvider>
      <MainDashboardScreenInner {...props} />
    </ToastProvider>
  );
}
