import pLimit from "p-limit";

type PortalCompany = {
  name: string;
  careersUrl: string;
  api?: string;
  enabled?: boolean;
};

type ApiTarget = {
  company: string;
  type: "greenhouse" | "ashby" | "lever";
  url: string;
};

export type InternetJob = {
  id: string;
  title: string;
  url: string;
  company: string;
  location: string;
  source: string;
  fetchedAt: string;
};

export type InternetJobsScanResult = {
  jobs: InternetJob[];
  totalScannedCompanies: number;
  totalFetchedJobs: number;
  fromCache: boolean;
  errors: Array<{ company: string; message: string }>;
};

type ScanOptions = {
  query?: string;
  forceRefresh?: boolean;
  limit?: number;
};

const FETCH_TIMEOUT_MS = 10_000;
const CONCURRENCY = 10;
const CACHE_TTL_MS = 15 * 60 * 1000;

const TITLE_POSITIVE = [
  "engineer",
  "developer",
  "ai",
  "ml",
  "llm",
  "agent",
  "automation",
  "product",
  "architect",
  "solutions",
  "frontend",
  "full stack",
  "fullstack",
  "platform",
  "applied"
];

const TITLE_NEGATIVE = ["intern", "internship", "junior", "student", "principal investigator"];

const TRACKED_COMPANIES: PortalCompany[] = [
  { name: "Anthropic", careersUrl: "https://job-boards.greenhouse.io/anthropic", api: "https://boards-api.greenhouse.io/v1/boards/anthropic/jobs", enabled: true },
  { name: "PolyAI", careersUrl: "https://job-boards.eu.greenhouse.io/polyai", api: "https://boards-api.greenhouse.io/v1/boards/polyai/jobs", enabled: true },
  { name: "Parloa", careersUrl: "https://job-boards.eu.greenhouse.io/parloa", api: "https://boards-api.greenhouse.io/v1/boards/parloa/jobs", enabled: true },
  { name: "Intercom", careersUrl: "https://job-boards.greenhouse.io/intercom", api: "https://boards-api.greenhouse.io/v1/boards/intercom/jobs", enabled: true },
  { name: "Hume AI", careersUrl: "https://job-boards.greenhouse.io/humeai", api: "https://boards-api.greenhouse.io/v1/boards/humeai/jobs", enabled: true },
  { name: "Airtable", careersUrl: "https://job-boards.greenhouse.io/airtable", api: "https://boards-api.greenhouse.io/v1/boards/airtable/jobs", enabled: true },
  { name: "Vercel", careersUrl: "https://job-boards.greenhouse.io/vercel", api: "https://boards-api.greenhouse.io/v1/boards/vercel/jobs", enabled: true },
  { name: "Temporal", careersUrl: "https://job-boards.greenhouse.io/temporal", api: "https://boards-api.greenhouse.io/v1/boards/temporal/jobs", enabled: true },
  { name: "Arize AI", careersUrl: "https://job-boards.greenhouse.io/arizeai", api: "https://boards-api.greenhouse.io/v1/boards/arizeai/jobs", enabled: true },
  { name: "RunPod", careersUrl: "https://job-boards.greenhouse.io/runpod", api: "https://boards-api.greenhouse.io/v1/boards/runpod/jobs", enabled: true },
  { name: "Glean", careersUrl: "https://job-boards.greenhouse.io/gleanwork", api: "https://boards-api.greenhouse.io/v1/boards/gleanwork/jobs", enabled: true },
  { name: "Speechmatics", careersUrl: "https://job-boards.greenhouse.io/speechmatics", api: "https://boards-api.greenhouse.io/v1/boards/speechmatics/jobs", enabled: true },
  { name: "Black Forest Labs", careersUrl: "https://job-boards.greenhouse.io/blackforestlabs", api: "https://boards-api.greenhouse.io/v1/boards/blackforestlabs/jobs", enabled: true },
  { name: "Helsing", careersUrl: "https://job-boards.greenhouse.io/helsing", api: "https://boards-api.greenhouse.io/v1/boards/helsing/jobs", enabled: true },
  { name: "Celonis", careersUrl: "https://job-boards.greenhouse.io/celonis", api: "https://boards-api.greenhouse.io/v1/boards/celonis/jobs", enabled: true },
  { name: "Contentful", careersUrl: "https://job-boards.greenhouse.io/contentful", api: "https://boards-api.greenhouse.io/v1/boards/contentful/jobs", enabled: true },
  { name: "GetYourGuide", careersUrl: "https://job-boards.greenhouse.io/getyourguide", api: "https://boards-api.greenhouse.io/v1/boards/getyourguide/jobs", enabled: true },
  { name: "HelloFresh", careersUrl: "https://job-boards.greenhouse.io/hellofresh", api: "https://boards-api.greenhouse.io/v1/boards/hellofresh/jobs", enabled: true },
  { name: "N26", careersUrl: "https://job-boards.greenhouse.io/n26", api: "https://boards-api.greenhouse.io/v1/boards/n26/jobs", enabled: true },
  { name: "Trade Republic", careersUrl: "https://job-boards.greenhouse.io/traderepublicbank", api: "https://boards-api.greenhouse.io/v1/boards/traderepublicbank/jobs", enabled: true },
  { name: "SumUp", careersUrl: "https://job-boards.greenhouse.io/sumup", api: "https://boards-api.greenhouse.io/v1/boards/sumup/jobs", enabled: true },
  { name: "Scandit", careersUrl: "https://job-boards.greenhouse.io/scandit", api: "https://boards-api.greenhouse.io/v1/boards/scandit/jobs", enabled: true },
  { name: "Wayve", careersUrl: "https://job-boards.greenhouse.io/wayve", api: "https://boards-api.greenhouse.io/v1/boards/wayve/jobs", enabled: true },
  { name: "Isomorphic Labs", careersUrl: "https://job-boards.greenhouse.io/isomorphiclabs", api: "https://boards-api.greenhouse.io/v1/boards/isomorphiclabs/jobs", enabled: true },
  { name: "Cohere", careersUrl: "https://jobs.ashbyhq.com/cohere", enabled: true },
  { name: "LangChain", careersUrl: "https://jobs.ashbyhq.com/langchain", enabled: true },
  { name: "Pinecone", careersUrl: "https://jobs.ashbyhq.com/pinecone", enabled: true },
  { name: "ElevenLabs", careersUrl: "https://jobs.ashbyhq.com/elevenlabs", enabled: true },
  { name: "Deepgram", careersUrl: "https://jobs.ashbyhq.com/deepgram", enabled: true },
  { name: "Vapi", careersUrl: "https://jobs.ashbyhq.com/vapi", enabled: true },
  { name: "Bland AI", careersUrl: "https://jobs.ashbyhq.com/bland", enabled: true },
  { name: "n8n", careersUrl: "https://jobs.ashbyhq.com/n8n", enabled: true },
  { name: "Zapier", careersUrl: "https://jobs.ashbyhq.com/zapier", enabled: true },
  { name: "Mistral AI", careersUrl: "https://jobs.lever.co/mistral", enabled: true },
  { name: "Weights & Biases", careersUrl: "https://jobs.lever.co/wandb", enabled: true },
  { name: "Palantir", careersUrl: "https://jobs.lever.co/palantir", enabled: true },
  { name: "Qonto", careersUrl: "https://jobs.lever.co/qonto", enabled: true },
  { name: "Forto", careersUrl: "https://jobs.lever.co/forto", enabled: true },
  { name: "Pigment", careersUrl: "https://jobs.lever.co/pigment", enabled: true }
];

let cache: { expiresAt: number; jobs: InternetJob[] } | null = null;

function detectApi(company: PortalCompany): ApiTarget | null {
  if (company.api?.includes("greenhouse")) {
    return { company: company.name, type: "greenhouse", url: company.api };
  }

  const url = company.careersUrl;
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i);
  if (ashbyMatch) {
    return {
      company: company.name,
      type: "ashby",
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`
    };
  }

  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/i);
  if (leverMatch) {
    return {
      company: company.name,
      type: "lever",
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`
    };
  }

  const greenhouseMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/i);
  if (greenhouseMatch) {
    return {
      company: company.name,
      type: "greenhouse",
      url: `https://boards-api.greenhouse.io/v1/boards/${greenhouseMatch[1]}/jobs`
    };
  }

  return null;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseGreenhouse(payload: unknown, company: string): InternetJob[] {
  const record = payload as { jobs?: Array<{ title?: string; absolute_url?: string; location?: { name?: string } }> };
  return (record.jobs ?? []).map((job) => ({
    id: `${company}:${job.title ?? ""}:${job.absolute_url ?? ""}`,
    title: job.title ?? "Untitled role",
    url: job.absolute_url ?? "",
    company,
    location: job.location?.name ?? "",
    source: "greenhouse-api",
    fetchedAt: new Date().toISOString()
  }));
}

function parseAshby(payload: unknown, company: string): InternetJob[] {
  const record = payload as { jobs?: Array<{ title?: string; jobUrl?: string; location?: string }> };
  return (record.jobs ?? []).map((job) => ({
    id: `${company}:${job.title ?? ""}:${job.jobUrl ?? ""}`,
    title: job.title ?? "Untitled role",
    url: job.jobUrl ?? "",
    company,
    location: job.location ?? "",
    source: "ashby-api",
    fetchedAt: new Date().toISOString()
  }));
}

function parseLever(payload: unknown, company: string): InternetJob[] {
  if (!Array.isArray(payload)) return [];
  return payload.map((job) => {
    const record = job as { text?: string; hostedUrl?: string; categories?: { location?: string } };
    return {
      id: `${company}:${record.text ?? ""}:${record.hostedUrl ?? ""}`,
      title: record.text ?? "Untitled role",
      url: record.hostedUrl ?? "",
      company,
      location: record.categories?.location ?? "",
      source: "lever-api",
      fetchedAt: new Date().toISOString()
    };
  });
}

function shouldKeepTitle(title: string): boolean {
  const lower = title.toLowerCase();
  const hasPositive = TITLE_POSITIVE.some((keyword) => lower.includes(keyword));
  const hasNegative = TITLE_NEGATIVE.some((keyword) => lower.includes(keyword));
  return hasPositive && !hasNegative;
}

function normalizeAndFilterJobs(rawJobs: InternetJob[], query?: string): InternetJob[] {
  const seenUrls = new Set<string>();
  const now = new Date().toISOString();
  const loweredQuery = query?.trim().toLowerCase() ?? "";

  return rawJobs
    .filter((job) => !!job.url && !!job.title)
    .filter((job) => shouldKeepTitle(job.title))
    .filter((job) => {
      if (seenUrls.has(job.url)) return false;
      seenUrls.add(job.url);
      return true;
    })
    .map((job) => ({ ...job, fetchedAt: now }))
    .filter((job) => {
      if (!loweredQuery) return true;
      return (
        job.title.toLowerCase().includes(loweredQuery) ||
        job.company.toLowerCase().includes(loweredQuery) ||
        job.location.toLowerCase().includes(loweredQuery)
      );
    });
}

export async function scanInternetJobs(options: ScanOptions = {}): Promise<InternetJobsScanResult> {
  const { query, forceRefresh = false, limit = 200 } = options;

  if (!forceRefresh && cache && cache.expiresAt > Date.now()) {
    const cachedJobs = normalizeAndFilterJobs(cache.jobs, query).slice(0, limit);
    return {
      jobs: cachedJobs,
      totalScannedCompanies: TRACKED_COMPANIES.filter((company) => company.enabled !== false).length,
      totalFetchedJobs: cache.jobs.length,
      fromCache: true,
      errors: []
    };
  }

  const enabledCompanies = TRACKED_COMPANIES.filter((company) => company.enabled !== false);
  const targets = enabledCompanies
    .map((company) => detectApi(company))
    .filter((entry): entry is ApiTarget => !!entry);

  const parserByType = {
    greenhouse: parseGreenhouse,
    ashby: parseAshby,
    lever: parseLever
  } as const;

  const limiter = pLimit(CONCURRENCY);
  const errors: Array<{ company: string; message: string }> = [];

  const jobsChunks = await Promise.all(
    targets.map((target) =>
      limiter(async () => {
        try {
          const json = await fetchJson(target.url);
          const parser = parserByType[target.type];
          return parser(json, target.company);
        } catch (error) {
          errors.push({
            company: target.company,
            message: error instanceof Error ? error.message : "Unknown error"
          });
          return [];
        }
      })
    )
  );

  const allJobs = jobsChunks.flat();
  const normalized = normalizeAndFilterJobs(allJobs).slice(0, limit);

  cache = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    jobs: normalized
  };

  return {
    jobs: normalizeAndFilterJobs(normalized, query).slice(0, limit),
    totalScannedCompanies: targets.length,
    totalFetchedJobs: allJobs.length,
    fromCache: false,
    errors
  };
}
