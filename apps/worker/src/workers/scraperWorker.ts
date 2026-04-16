import type { Job } from "bullmq";
import { workerAdvanceStep, workerLogEvent, workerUpdateStep } from "../lib/apiClient.js";

const SCRAPE_TIMEOUT_MS = 15_000;
const MAX_JD_CHARS = 12_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractJobDescriptionText(rawText: string, targetRole?: string): string {
  // Try to find the job description section by looking for anchor keywords
  const anchors = [
    "responsibilities",
    "about the role",
    "about the job",
    "the role",
    "job description",
    "what you'll do",
    "what you will do",
    "qualifications",
    "requirements",
    "what we're looking for",
    "minimum qualifications",
  ];

  const lower = rawText.toLowerCase();
  let startIndex = -1;

  for (const anchor of anchors) {
    const idx = lower.indexOf(anchor);
    if (idx !== -1) {
      startIndex = Math.max(0, idx - 200);
      break;
    }
  }

  const relevant = startIndex >= 0 ? rawText.slice(startIndex) : rawText;

  // Clean up and limit
  const lines = relevant
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 10);

  const combined = lines.join("\n");

  const prefix = targetRole ? `Job Title: ${targetRole}\n\n` : "";
  return (prefix + combined).slice(0, MAX_JD_CHARS).trim();
}

async function fetchJobDescription(jobUrl: string, targetRole?: string): Promise<string | null> {
  if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

  try {
    const response = await fetch(jobUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return null;
    }

    const html = await response.text();
    const rawText = stripHtml(html);
    return extractJobDescriptionText(rawText, targetRole);
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export async function runScraper(job: Job): Promise<void> {
  const { applicationId, targetRole, jobUrl, metadata } = job.data as {
    applicationId: string;
    targetRole?: string;
    jobUrl?: string;
    metadata?: Record<string, unknown>;
  };

  let jobDescription: string | null = null;
  let scrapedSuccessfully = false;

  try {
    jobDescription = await fetchJobDescription(jobUrl ?? "", targetRole);
    scrapedSuccessfully = Boolean(jobDescription && jobDescription.length > 100);
  } catch {
    // Scraping failed — pipeline continues with no JD text
  }

  await workerLogEvent({
    applicationId,
    step: "job_scraped",
    message: scrapedSuccessfully
      ? `Job description extracted (${jobDescription?.length ?? 0} chars)`
      : "Job page not fetchable — proceeding with role-based analysis",
    payloadJson: {
      title: targetRole ?? "unknown-role",
      source: jobUrl ?? "unknown-url",
      scrapedSuccessfully,
      jobDescriptionLength: jobDescription?.length ?? 0,
    },
  });

  if (scrapedSuccessfully && jobDescription) {
    await workerUpdateStep({
      applicationId,
      currentStep: "job_scraped",
      checkpointJson: {
        metadata: {
          ...(metadata ?? {}),
          jobDescription,
          jobDescriptionSource: jobUrl,
        },
      },
    });
  }

  await workerAdvanceStep({ applicationId, nextStep: "job_analyzed" });
}

