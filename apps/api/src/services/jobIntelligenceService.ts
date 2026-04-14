/**
 * jobIntelligenceService.ts
 *
 * Pure-logic job intelligence engine ported from Career-Ops.
 * No file I/O, no CLI, no markdown output — only typed functions that
 * operate on strings and return structured data.
 *
 * Logic sourced from:
 *  - career-ops/modes/oferta.md  (Blocks A, B, G definitions)
 *  - career-ops/modes/_shared.md  (archetype table, scoring system)
 *  - career-ops/analyze-patterns.mjs (blocker extraction, classifiers)
 *  - career-ops/liveness-core.mjs  (ghost/expired job detection)
 */

import { getSkillMatchScore } from "@autoapply/shared";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type RoleArchetype =
  | "AI Platform / LLMOps"
  | "Agentic / Automation"
  | "Technical AI PM"
  | "AI Solutions Architect"
  | "AI Forward Deployed"
  | "AI Transformation"
  | "Software Engineer"
  | "Data Scientist / ML"
  | "DevOps / Infrastructure"
  | "Product Manager"
  | "Unknown";

export type Seniority =
  | "Intern"
  | "Entry-Level"
  | "Mid-Level"
  | "Senior"
  | "Staff / Principal"
  | "Lead / Manager"
  | "Director+"
  | "Unknown";

export type RemotePolicy =
  | "fully-remote"
  | "hybrid"
  | "onsite"
  | "geo-restricted"
  | "unknown";

export type LegitimacyTier =
  | "High Confidence"
  | "Proceed with Caution"
  | "Suspicious";

export type SkillWeight = "required" | "preferred" | "mentioned";
export type GapSeverity = "hard-blocker" | "significant" | "nice-to-have";
export type SignalWeight = "Positive" | "Neutral" | "Concerning";

export interface ExtractedSkill {
  skill: string;
  weight: SkillWeight;
  matchedInProfile: boolean;
}

export interface CvGap {
  requirement: string;
  severity: GapSeverity;
  mitigation: string;
}

export interface LegitimacySignal {
  signal: string;
  finding: string;
  weight: SignalWeight;
}

export interface JobRoleSummary {
  /** Block A — role metadata */
  archetype: RoleArchetype;
  secondaryArchetype: RoleArchetype | null;
  seniority: Seniority;
  remotePolicy: RemotePolicy;
  domain: string;
  function: string;
  tldr: string;
}

export interface CvMatchResult {
  /** Block B — matched skills and gaps */
  matchedSkills: ExtractedSkill[];
  gaps: CvGap[];
  matchScoreEstimate: number; // 0-5
}

export interface GhostRiskResult {
  /** Block G — posting legitimacy */
  legitimacyTier: LegitimacyTier;
  signals: LegitimacySignal[];
  contextNotes: string[];
}

export interface JobIntelligenceResult {
  roleSummary: JobRoleSummary;
  requiredSkills: string[];
  preferredSkills: string[];
  keywords: string[];
  cvMatch: CvMatchResult;
  ghostRisk: GhostRiskResult;
  overallScore: number; // weighted 0-5
}

// ─────────────────────────────────────────────────────────────
// Block A — Archetype Detection
// Source: career-ops/modes/_shared.md § Archetype Detection
// ─────────────────────────────────────────────────────────────

const ARCHETYPE_SIGNALS: Record<RoleArchetype, RegExp[]> = {
  "AI Platform / LLMOps": [
    /\b(observability|evals?|evaluation|monitoring|reliability|llmops|mlops|pipelines?|serving|deployment|vector\s*db)\b/i,
  ],
  "Agentic / Automation": [
    /\b(agent|agentic|HITL|human[- ]in[- ]the[- ]loop|orchestrat|workflow|multi[- ]agent|langgraph|langchain|autogen|crew)\b/i,
  ],
  "Technical AI PM": [
    /\b(PRD|roadmap|discovery|stakeholder|product\s*manag|prioritiz|go[- ]to[- ]market|OKR)\b/i,
  ],
  "AI Solutions Architect": [
    /\b(architect|enterprise|integration|design\s*pattern|system\s*design|solution\s*design|pre[- ]sales)\b/i,
  ],
  "AI Forward Deployed": [
    /\b(client[- ]facing|deploy|prototype|field|rapid\s*deliver|customer[- ]facing|forward\s*deployed)\b/i,
  ],
  "AI Transformation": [
    /\b(change\s*management|adoption|enablement|transformation|upskill|center\s*of\s*excellence)\b/i,
  ],
  "Software Engineer": [
    /\b(software\s*engineer|full[- ]stack|backend\s*engineer|frontend\s*engineer|web\s*developer|SWE)\b/i,
  ],
  "Data Scientist / ML": [
    /\b(data\s*scientist|machine\s*learning|deep\s*learning|neural\s*network|NLP|computer\s*vision|training|fine[- ]tun)\b/i,
  ],
  "DevOps / Infrastructure": [
    /\b(devops|infrastructure|SRE|platform\s*engineer|CI[\/\-]CD|kubernetes|terraform|helm)\b/i,
  ],
  "Product Manager": [
    /\b(product\s*manager|PM\b|product\s*owner|product\s*strategy)\b/i,
  ],
  Unknown: [],
};

export function detectArchetype(jd: string): { primary: RoleArchetype; secondary: RoleArchetype | null } {
  const scores: Partial<Record<RoleArchetype, number>> = {};

  for (const [archetype, patterns] of Object.entries(ARCHETYPE_SIGNALS) as [RoleArchetype, RegExp[]][]) {
    if (archetype === "Unknown") continue;
    const matchCount = patterns.reduce((acc, pattern) => {
      const matches = jd.match(new RegExp(pattern.source, "gi"));
      return acc + (matches?.length ?? 0);
    }, 0);
    if (matchCount > 0) scores[archetype] = matchCount;
  }

  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a) as [RoleArchetype, number][];

  if (sorted.length === 0) return { primary: "Unknown", secondary: null };
  if (sorted.length === 1) return { primary: sorted[0][0], secondary: null };

  const [first, second] = sorted;
  // Only show secondary if its score is at least 40% of primary
  const hasSecondary = second[1] >= first[1] * 0.4;
  return {
    primary: first[0],
    secondary: hasSecondary ? second[0] : null,
  };
}

// ─────────────────────────────────────────────────────────────
// Block A — Seniority Detection
// Source: career-ops/analyze-patterns.mjs § extractBlockerType
// ─────────────────────────────────────────────────────────────

const SENIORITY_PATTERNS: { level: Seniority; patterns: RegExp[] }[] = [
  { level: "Intern", patterns: [/\b(intern|internship|co-?op)\b/i] },
  {
    level: "Entry-Level",
    patterns: [/\b(entry[- ]level|junior|jr\.?|associate|new\s*grad|0[–-]2\s*years?)\b/i],
  },
  {
    level: "Mid-Level",
    patterns: [/\b(mid[- ]level|2[–-]5\s*years?|intermediate)\b/i],
  },
  {
    level: "Senior",
    patterns: [/\b(senior|sr\.?|5\+?\s*years?|experienced)\b/i],
  },
  {
    level: "Staff / Principal",
    patterns: [/\b(staff|principal|architect\b|distinguished|8\+?\s*years?)\b/i],
  },
  {
    level: "Lead / Manager",
    patterns: [/\b(lead|manager|team\s*lead|engineering\s*manager|EM\b)\b/i],
  },
  {
    level: "Director+",
    patterns: [/\b(director|VP\b|head\s*of|c[- ]?suite|chief|EVP)\b/i],
  },
];

export function detectSeniority(jd: string): Seniority {
  for (const { level, patterns } of SENIORITY_PATTERNS) {
    if (patterns.some((p) => p.test(jd))) return level;
  }
  return "Unknown";
}

// ─────────────────────────────────────────────────────────────
// Block A — Remote Policy
// Source: career-ops/analyze-patterns.mjs § classifyRemote
// ─────────────────────────────────────────────────────────────

export function detectRemotePolicy(jd: string): RemotePolicy {
  const lower = jd.toLowerCase();
  if (/\b(us[- ]?only|canada[- ]?only|residents only|usa only|us residents|must be located in)\b/.test(lower))
    return "geo-restricted";
  if (/\b(hybrid|on-?site|in[- ]office|must relocate|required in office)\b/.test(lower))
    return "hybrid";
  if (/\b(fully\s*remote|100%\s*remote|work from anywhere|global remote|anywhere)\b/.test(lower))
    return "fully-remote";
  if (/\b(remote)\b/.test(lower)) return "fully-remote";
  if (/\b(onsite|on site|in person|office[- ]based)\b/.test(lower)) return "onsite";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────
// Block A — Domain / Function detection
// Source: career-ops/modes/_shared.md
// ─────────────────────────────────────────────────────────────

export function detectDomain(jd: string): string {
  const lower = jd.toLowerCase();
  if (/\b(llm|large language model|generative ai|gen[- ]?ai|gpt|claude|gemini|foundation model)\b/.test(lower)) return "Generative AI";
  if (/\b(nlp|natural language|text\s*classification|sentiment)\b/.test(lower)) return "NLP";
  if (/\b(computer vision|image\s*recognition|object\s*detect|cv model)\b/.test(lower)) return "Computer Vision";
  if (/\b(data\s*platform|warehousing|etl|pipeline|data\s*engineer)\b/.test(lower)) return "Data Platform";
  if (/\b(enterprise|saas|b2b|platform)\b/.test(lower)) return "Enterprise SaaS";
  if (/\b(fintech|finance|banking|payments)\b/.test(lower)) return "FinTech";
  if (/\b(health|medical|clinical|pharma|biotech)\b/.test(lower)) return "HealthTech";
  return "General Tech";
}

export function detectFunction(jd: string): string {
  const lower = jd.toLowerCase();
  if (/\b(build|engineer|develop|implement|ship)\b/.test(lower)) return "build";
  if (/\b(consult|advise|solution|client|partner)\b/.test(lower)) return "consult";
  if (/\b(manage|lead|strategy|headcount|organization)\b/.test(lower)) return "manage";
  if (/\b(deploy|operate|maintain|scale|infra)\b/.test(lower)) return "deploy";
  return "build";
}

// ─────────────────────────────────────────────────────────────
// Skill Extraction (used by Block B)
// Source: career-ops/analyze-patterns.mjs § techStackGaps
// ─────────────────────────────────────────────────────────────

const KNOWN_TECH_SKILLS = [
  // Languages
  "Python", "JavaScript", "TypeScript", "Java", "Go", "Rust", "Ruby", "C++", "C#",
  "Swift", "Kotlin", "PHP", "Scala", "R",
  // Frameworks / Libraries
  "React", "Next.js", "Vue.js", "Angular", "Django", "Flask", "FastAPI", "Rails",
  "Express", "NestJS", "Spring", "Laravel",
  // AI / ML
  "TensorFlow", "PyTorch", "Keras", "scikit-learn", "HuggingFace", "LangChain",
  "LlamaIndex", "OpenAI", "Anthropic", "Gemini", "LangGraph", "AutoGen",
  "Pinecone", "Weaviate", "ChromaDB", "pgvector",
  // Databases
  "PostgreSQL", "MySQL", "MongoDB", "Redis", "Elasticsearch", "Cassandra",
  "DynamoDB", "Supabase", "Firebase",
  // Cloud / Infra
  "AWS", "GCP", "Azure", "Docker", "Kubernetes", "Terraform", "Helm",
  "GitHub Actions", "CircleCI", "Jenkins",
  // Other
  "GraphQL", "REST", "gRPC", "WebSockets", "Kafka", "RabbitMQ", "Celery",
  "Git", "Linux", "Nginx", "Prometheus", "Grafana",
];

const SOFT_SKILLS = [
  "communication", "collaboration", "cross-functional", "ownership", "leadership",
  "mentorship", "problem-solving", "analytical", "stakeholder management",
];

const REQUIRED_SIGNALS = /\b(required|must have|must know|mandatory|essential|you have|you will bring|you bring)\b/i;
const PREFERRED_SIGNALS = /\b(preferred|nice to have|bonus|plus|ideally|desirable|familiarity with)\b/i;

export function extractSkills(jd: string): {
  required: string[];
  preferred: string[];
  all: string[];
} {
  const lower = jd.toLowerCase();
  const required = new Set<string>();
  const preferred = new Set<string>();
  const all = new Set<string>();

  for (const skill of KNOWN_TECH_SKILLS) {
    const skillLower = skill.toLowerCase();
    if (!lower.includes(skillLower)) continue;

    // Search a small window around the skill mention for context
    const idx = lower.indexOf(skillLower);
    const contextBefore = jd.slice(Math.max(0, idx - 150), idx);

    all.add(skill);

    if (REQUIRED_SIGNALS.test(contextBefore)) {
      required.add(skill);
    } else if (PREFERRED_SIGNALS.test(contextBefore)) {
      preferred.add(skill);
    } else {
      // Default: if not explicitly preferred, treat as required for scoring purposes
      required.add(skill);
    }
  }

  return {
    required: [...required],
    preferred: [...preferred],
    all: [...all],
  };
}

export function extractKeywords(jd: string): string[] {
  const keywords = new Set<string>();

  // Extract all tech skills
  const { all } = extractSkills(jd);
  all.forEach((s) => keywords.add(s));

  // Extract domain-specific terms using regex
  const domainTerms = jd.match(
    /\b(RAG|RLHF|PEFT|LoRA|tokenization|embedding|vector\s*search|fine[- ]tun|inference|latency|throughput|evals?|A\/B\s*test|LLM|GPT|transformer|attention|MLOps|LLMOps|CI\/CD|IaC|zero[- ]shot|few[- ]shot|chain[- ]of[- ]thought|prompt\s*engineer)\b/gi
  );
  domainTerms?.forEach((term) => keywords.add(term));

  return [...keywords].slice(0, 25);
}

// ─────────────────────────────────────────────────────────────
// Block B — CV/JD Matching
// Source: career-ops/modes/oferta.md § Bloque B
// ─────────────────────────────────────────────────────────────

export function matchCvToJd(
  jdSkills: { required: string[]; preferred: string[] },
  profileSkills: string[],
  profileText: string
): CvMatchResult {
  const profileLower = profileText.toLowerCase();

  const SKILL_NORMALIZATION: Record<string, string> = {
    postgresql: "postgres",
    sqlserver: "sql",
    node: "nodejs",
    machinelearning: "machine_learning",
    deeplearning: "deep_learning",
    "machine learning": "machine_learning",
    "deep learning": "deep_learning"
  };

  const normalizeSkillToken = (value: string): string => {
    const compact = value
      .toLowerCase()
      .replace(/[^a-z0-9_ ]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
    if (!compact) return "";
    const collapsed = compact.replace(/\s+/g, "");
    const direct = SKILL_NORMALIZATION[compact] ?? SKILL_NORMALIZATION[collapsed] ?? compact;
    return direct.replace(/\s+/g, "_");
  };

  const profileSkillsNormalized = profileSkills
    .map((skill) => normalizeSkillToken(skill))
    .filter(Boolean);

  // Include text-derived skills to preserve existing lexical behavior while adding family semantics.
  const textTermsNormalized = profileLower
    .split(/[^a-z0-9_]+/)
    .map((token) => normalizeSkillToken(token))
    .filter(Boolean);

  const userSkillPool = Array.from(new Set([...profileSkillsNormalized, ...textTermsNormalized]));

  const matchedSkills: ExtractedSkill[] = [];
  const gaps: CvGap[] = [];

  let requiredScoreSum = 0;
  let preferredScoreSum = 0;

  // Check required skills
  for (const skill of jdSkills.required) {
    const normalizedSkill = normalizeSkillToken(skill);
    const matchScore = getSkillMatchScore(normalizedSkill, userSkillPool);
    const matched = matchScore > 0;

    requiredScoreSum += matchScore;

    matchedSkills.push({
      skill,
      weight: "required",
      matchedInProfile: matched,
    });

    if (matchScore === 0) {
      gaps.push({
        requirement: skill,
        severity: "hard-blocker",
        mitigation: `Add ${skill} to skills or highlight adjacent experience. If truly missing, address it in the cover letter.`,
      });
    }
  }

  // Check preferred skills
  for (const skill of jdSkills.preferred) {
    const normalizedSkill = normalizeSkillToken(skill);
    const matchScore = getSkillMatchScore(normalizedSkill, userSkillPool);
    const matched = matchScore > 0;

    preferredScoreSum += matchScore;

    matchedSkills.push({
      skill,
      weight: "preferred",
      matchedInProfile: matched,
    });

    if (matchScore === 0) {
      gaps.push({
        requirement: skill,
        severity: "nice-to-have",
        mitigation: `${skill} is preferred but not blocking. Mention any adjacent experience.`,
      });
    }
  }

  // Compute match score (0-5)
  const requiredTotal = jdSkills.required.length;
  const preferredTotal = jdSkills.preferred.length;

  let score = 0;
  if (requiredTotal > 0) {
    // Required skills account for 70% of the score
    score += (requiredScoreSum / requiredTotal) * 3.5;
  } else {
    score += 3.5; // no required skills listed → favour
  }
  if (preferredTotal > 0) {
    // Preferred skills account for 30%
    score += (preferredScoreSum / preferredTotal) * 1.5;
  } else {
    score += 1.5;
  }

  return {
    matchedSkills,
    gaps,
    matchScoreEstimate: Math.round(Math.min(5, score) * 10) / 10,
  };
}

// ─────────────────────────────────────────────────────────────
// Block G — Ghost / Posting Legitimacy Detection
// Source: career-ops/modes/oferta.md § Bloque G
//         career-ops/liveness-core.mjs
//         career-ops/modes/_shared.md § Posting Legitimacy
// ─────────────────────────────────────────────────────────────

/** Patterns taken directly from career-ops/liveness-core.mjs */
const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
];

const REQUIREMENTS_REALISM_ISSUES = [
  // Years of exp greater than technology's existence
  /(\d+)\s*\+?\s*years?.{0,30}(kubernetes|docker|react|typescript|gpt|llm|langchain)/i,
  // Contradictions (entry-level title with senior requirements)
  /junior.{0,200}8\+\s*years/is,
  /entry[- ]level.{0,200}10\+\s*years/is,
];

const EVERMORE_POSTING_SIGNALS = [
  /\b(evergreen|ongoing|rolling\s*basis|continuous\s*hiring|talent\s*pool)\b/i,
];

const GENERIC_JD_SIGNALS = [
  /\b(exciting opportunity|fast[- ]paced environment|competitive salary|passionate|detail[- ]oriented|team\s*player)\b/gi,
];

export function analyzeGhostRisk(params: {
  jdText: string;
  jobTitle: string;
  companyName: string;
  postingAgedays?: number | null;
  hasApplyButton?: boolean;
  /** Number of times the same company+role has been reposted in last 90 days */
  repostCount?: number;
}): GhostRiskResult {
  const { jdText, jobTitle, companyName, postingAgedays, hasApplyButton, repostCount = 0 } = params;
  const signals: LegitimacySignal[] = [];
  const contextNotes: string[] = [];

  // ── Signal 1: Posting freshness ──────────────────────────────
  if (postingAgedays !== null && postingAgedays !== undefined) {
    const ageLabel = `${postingAgedays} days old`;
    if (postingAgedays <= 14) {
      signals.push({ signal: "Posting freshness", finding: `Fresh (${ageLabel})`, weight: "Positive" });
    } else if (postingAgedays <= 30) {
      signals.push({ signal: "Posting freshness", finding: `Recent (${ageLabel})`, weight: "Neutral" });
    } else if (postingAgedays <= 60) {
      signals.push({ signal: "Posting freshness", finding: `Aging (${ageLabel})`, weight: "Concerning" });
    } else {
      signals.push({ signal: "Posting freshness", finding: `Old (${ageLabel})`, weight: "Concerning" });
    }
  } else {
    signals.push({ signal: "Posting freshness", finding: "Date unknown — limited data", weight: "Neutral" });
    contextNotes.push("Posting age could not be determined. Insufficient data to assess freshness.");
  }

  // ── Signal 2: Apply button ────────────────────────────────────
  if (hasApplyButton !== undefined) {
    signals.push({
      signal: "Apply button",
      finding: hasApplyButton ? "Visible and active" : "Missing or inactive",
      weight: hasApplyButton ? "Positive" : "Concerning",
    });
  }

  // ── Signal 3: Expired content patterns ───────────────────────
  const hasExpiredPattern = HARD_EXPIRED_PATTERNS.some((p) => p.test(jdText));
  if (hasExpiredPattern) {
    signals.push({ signal: "Expired content", finding: "Job page contains closed/expired language", weight: "Concerning" });
  }

  // ── Signal 4: JD quality — tech specificity ───────────────────
  const { all: allSkills } = extractSkills(jdText);
  if (allSkills.length >= 4) {
    signals.push({ signal: "Technology specificity", finding: `${allSkills.length} specific technologies named`, weight: "Positive" });
  } else if (allSkills.length >= 2) {
    signals.push({ signal: "Technology specificity", finding: `Only ${allSkills.length} specific technologies — moderately generic`, weight: "Neutral" });
  } else {
    signals.push({ signal: "Technology specificity", finding: "Very few or no specific technologies — likely generic posting", weight: "Concerning" });
  }

  // ── Signal 5: Requirements realism ────────────────────────────
  const hasUnrealisticReq = REQUIREMENTS_REALISM_ISSUES.some((p) => p.test(jdText));
  const genericCount = (jdText.match(GENERIC_JD_SIGNALS[0]) ?? []).length;

  if (hasUnrealisticReq) {
    signals.push({ signal: "Requirements realism", finding: "Possible contradiction detected (e.g., years of experience vs technology age)", weight: "Concerning" });
  }
  if (genericCount >= 4) {
    signals.push({ signal: "JD boilerplate ratio", finding: `${genericCount} generic filler phrases detected`, weight: "Concerning" });
  } else {
    signals.push({ signal: "JD boilerplate ratio", finding: "Boilerplate within normal range", weight: "Neutral" });
  }

  // ── Signal 6: Reposting ───────────────────────────────────────
  if (repostCount >= 2) {
    signals.push({ signal: "Reposting pattern", finding: `Role reposted ${repostCount} times in the last 90 days`, weight: "Concerning" });
  } else if (repostCount === 1) {
    signals.push({ signal: "Reposting pattern", finding: "Reposted once — could be refreshed or refilled", weight: "Neutral" });
  }

  // ── Signal 7: Evergreen signals ───────────────────────────────
  const isEvergreen = EVERMORE_POSTING_SIGNALS.some((p) => p.test(jdText));
  if (isEvergreen) {
    contextNotes.push("This appears to be an evergreen/continuous hiring posting. Longer duration is normal and not a ghost indicator.");
    signals.push({ signal: "Evergreen posting", finding: "Marked as ongoing/rolling — not a ghost indicator", weight: "Positive" });
  }

  // ── Signal 8: Salary info ──────────────────────────────────────
  const hasSalary = /\$[\d,]+|\b(salary|compensation|pay range|total comp|₹|€|£)\b/i.test(jdText);
  if (hasSalary) {
    signals.push({ signal: "Salary transparency", finding: "Compensation information provided", weight: "Positive" });
  } else {
    signals.push({ signal: "Salary transparency", finding: "No salary information (may be jurisdiction-dependent)", weight: "Neutral" });
  }

  // ── Signal 9: Scope clarity ───────────────────────────────────
  const hasFirstNinetyDays = /\b(first (90|30|60) days|in your first|within \d+ months|onboarding|success criteria)\b/i.test(jdText);
  if (hasFirstNinetyDays) {
    signals.push({ signal: "Role scope clarity", finding: "Clear onboarding or first-90-days roadmap mentioned", weight: "Positive" });
  }

  // ── Tier calculation ───────────────────────────────────────────
  const concerningCount = signals.filter((s) => s.weight === "Concerning").length;
  const positiveCount = signals.filter((s) => s.weight === "Positive").length;

  let legitimacyTier: LegitimacyTier;
  if (hasExpiredPattern || concerningCount >= 4) {
    legitimacyTier = "Suspicious";
  } else if (concerningCount >= 2 || (concerningCount >= 1 && positiveCount < 2)) {
    legitimacyTier = "Proceed with Caution";
  } else {
    legitimacyTier = "High Confidence";
  }

  return { legitimacyTier, signals, contextNotes };
}

// ─────────────────────────────────────────────────────────────
// Score Computation
// Source: career-ops/modes/_shared.md § Scoring System
// ─────────────────────────────────────────────────────────────

export function computeOverallScore(params: {
  cvMatchScore: number;   // 0-5
  ghostRisk: GhostRiskResult;
  remotePolicy: RemotePolicy;
  /** User's preferred remote policies — passed in from profile */
  preferredRemotePolicies?: RemotePolicy[];
}): number {
  const { cvMatchScore, ghostRisk, remotePolicy, preferredRemotePolicies = ["fully-remote"] } = params;

  let score = cvMatchScore;

  // Cultural / remote penalty: if the role doesn't match preferred remote policy
  const remoteMatch = preferredRemotePolicies.includes(remotePolicy);
  if (!remoteMatch && remotePolicy === "onsite") score -= 0.5;
  if (!remoteMatch && remotePolicy === "geo-restricted") score -= 0.8;

  // Ghost risk penalty
  if (ghostRisk.legitimacyTier === "Suspicious") score -= 0.5;
  if (ghostRisk.legitimacyTier === "Proceed with Caution") score -= 0.2;

  return Math.round(Math.max(0, Math.min(5, score)) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// TL;DR generator
// ─────────────────────────────────────────────────────────────

export function buildTldr(params: {
  jobTitle: string;
  companyName: string;
  archetype: RoleArchetype;
  seniority: Seniority;
  remotePolicy: RemotePolicy;
}): string {
  const { jobTitle, companyName, archetype, seniority, remotePolicy } = params;
  const remoteStr = remotePolicy === "fully-remote" ? "fully remote" : remotePolicy;
  return `${seniority} ${jobTitle} at ${companyName} (${archetype}), ${remoteStr}.`;
}

// ─────────────────────────────────────────────────────────────
// Decision Engine — Score Normalisation + Apply Decision
//
// Sits on top of computeOverallScore() (0-5 scale).
// Does NOT modify existing functions.
// ─────────────────────────────────────────────────────────────

export type ApplyDecision = "APPLY" | "RISKY" | "SKIP";
export type ApplyPriority = "HIGH" | "MEDIUM" | "LOW";

/**
 * Normalise the 0-5 internal score to 0-100.
 */
export function normalizeScore(overallScore: number): number {
  return Math.round((overallScore / 5) * 100);
}

/**
 * Binary apply decision based on normalised score (0-100).
 */
export function computeDecision(score: number): ApplyDecision {
  if (score >= 70) return "APPLY";
  if (score >= 40) return "RISKY";
  return "SKIP";
}

/**
 * Apply priority band based on normalised score (0-100).
 */
export function computePriority(score: number): ApplyPriority {
  if (score >= 80) return "HIGH";
  if (score >= 60) return "MEDIUM";
  return "LOW";
}

// ─────────────────────────────────────────────────────────────
// Risk Flag Extraction
// Converts ghostRisk signals + cvMatch gaps into flat string flags.
// ─────────────────────────────────────────────────────────────

export type RiskFlag =
  | "LOW_MATCH"
  | "SENIORITY_MISMATCH"
  | "VAGUE_JD"
  | "POSSIBLE_GHOST"
  | "GEO_RESTRICTED"
  | "ONSITE_ONLY"
  | "HARD_SKILL_GAP"
  | "REPOSTED";

export function extractRiskFlags(params: {
  score: number;           // normalised 0-100
  ghostRisk: GhostRiskResult;
  cvMatch: CvMatchResult;
  remotePolicy: RemotePolicy;
  seniority: Seniority;
  jdSkillCount: number;    // total skills found in JD
}): RiskFlag[] {
  const { score, ghostRisk, cvMatch, remotePolicy, seniority, jdSkillCount } = params;
  const flags = new Set<RiskFlag>();

  // Low overall match
  if (score < 50) flags.add("LOW_MATCH");

  // Ghost / legitimacy flags
  if (ghostRisk.legitimacyTier === "Suspicious") flags.add("POSSIBLE_GHOST");

  // Reposting signal
  const repostSignal = ghostRisk.signals.find(
    (s) => s.signal === "Reposting pattern" && s.weight === "Concerning"
  );
  if (repostSignal) flags.add("REPOSTED");

  // Vague JD — very few technologies named
  if (jdSkillCount < 2) flags.add("VAGUE_JD");

  // Remote / geo flags
  if (remotePolicy === "geo-restricted") flags.add("GEO_RESTRICTED");
  if (remotePolicy === "onsite") flags.add("ONSITE_ONLY");

  // Hard skill gap — at least one hard-blocker unmatched gap
  const hasHardGap = cvMatch.gaps.some((g) => g.severity === "hard-blocker");
  if (hasHardGap) flags.add("HARD_SKILL_GAP");

  // Seniority mismatch — JD wants senior/staff but user profile looks junior
  // (proxy: if seniority is Director+ or Staff/Principal and score < 60)
  if ((seniority === "Director+" || seniority === "Staff / Principal") && score < 60) {
    flags.add("SENIORITY_MISMATCH");
  }

  return [...flags];
}

// ─────────────────────────────────────────────────────────────
// Score Breakdown (sub-scores for transparency)
// ─────────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  /** Normalized 0..1 of JD skills found in profile (required + preferred) */
  skill_match: number;
  /** Normalized 0..1 of JD keywords found in profile text */
  keyword_overlap: number;
  /**
   * Normalized 0..1 heuristic experience match:
   * penalises if JD seniority exceeds Entry-Level and profileText is short / sparse.
   */
  experience_match: number;
}

export function computeScoreBreakdown(params: {
  cvMatch: CvMatchResult;
  keywords: string[];
  profileText: string;
  seniority: Seniority;
}): ScoreBreakdown {
  const { cvMatch, keywords, profileText, seniority } = params;
  const profileLower = profileText.toLowerCase();

  // Skill match — percentage of all tracked skills that matched
  const totalTracked = cvMatch.matchedSkills.length;
  const totalMatched = cvMatch.matchedSkills.filter((s) => s.matchedInProfile).length;
  const skill_match =
    totalTracked > 0 ? (totalMatched / totalTracked) : 1;

  // Keyword overlap — percentage of domain keywords found in profile text
  const keywordHits = keywords.filter((kw) => profileLower.includes(kw.toLowerCase())).length;
  const keyword_overlap =
    keywords.length > 0 ? (keywordHits / keywords.length) : 1;

  // Experience match — heuristic based on seniority & profile length
  const SENIORITY_WEIGHT: Record<Seniority, number> = {
    Intern: 1,
    "Entry-Level": 0.9,
    "Mid-Level": 0.8,
    Senior: 0.65,
    "Staff / Principal": 0.5,
    "Lead / Manager": 0.5,
    "Director+": 0.4,
    Unknown: 0.8,
  };
  const profileWords = profileLower.split(/\s+/).length;
  // Assume a reasonable senior profile has 400+ words
  const profileDepth = Math.min(1, profileWords / 400);
  const seniorityFactor = SENIORITY_WEIGHT[seniority] ?? 0.8;
  const experience_match = Math.max(0, Math.min(1, profileDepth * seniorityFactor));

  return { skill_match, keyword_overlap, experience_match };
}

export interface AnalysisReasons {
  missing_skills: string[];
  experience_gap: string | null;
  keyword_mismatch: string[];
  risk_summary: Array<{ type: string; message: string }>;
  risk_summary_text: string[];
}

export type TailoredResume = {
  summary: string;
  skills: string[];
  experience: {
    title: string;
    bullets: string[];
  }[];
  keywordsInjected: string[];
};

const IMPORTANT_KEYWORDS = [
  "scalability",
  "performance",
  "distributed",
  "microservices",
  "observability"
];

const SOFT_WORDS = ["team", "communication", "collaboration", "leadership"];

function formatTokenForDisplay(token: string): string {
  return token.replaceAll("_", " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countTermFrequencyInText(text: string, term: string): number {
  if (!term.trim()) return 0;
  const pattern = new RegExp(`\\b${escapeRegExp(term.toLowerCase())}\\b`, "gi");
  return (text.match(pattern) ?? []).length;
}

function rankMissingSkills(cvMatch: CvMatchResult, jdText: string, maxItems = 5): string[] {
  const jdLower = jdText.toLowerCase();
  const missing = cvMatch.matchedSkills
    .filter((skill) => !skill.matchedInProfile)
    .map((skill) => ({
      skill: skill.skill,
      weight: skill.weight,
      frequency: countTermFrequencyInText(jdLower, skill.skill),
    }));

  missing.sort((a, b) => {
    const weightA = a.weight === "required" ? 2 : a.weight === "preferred" ? 1 : 0;
    const weightB = b.weight === "required" ? 2 : b.weight === "preferred" ? 1 : 0;
    if (weightA !== weightB) return weightB - weightA;
    if (a.frequency !== b.frequency) return b.frequency - a.frequency;
    return a.skill.localeCompare(b.skill);
  });

  return missing.slice(0, maxItems).map((item) => item.skill);
}

function toRiskType(signal: LegitimacySignal): string {
  const normalizedSignal = signal.signal.toLowerCase();
  const normalizedFinding = signal.finding.toLowerCase();

  if (normalizedSignal.includes("posting freshness") && (normalizedFinding.includes("aging") || normalizedFinding.includes("old"))) {
    return "STALE_POST";
  }
  if (normalizedSignal.includes("expired")) return "EXPIRED_POST";
  if (normalizedSignal.includes("reposting")) return "REPOSTED";
  if (normalizedSignal.includes("apply button") && normalizedFinding.includes("missing")) return "NO_APPLY_BUTTON";
  if (normalizedSignal.includes("technology specificity")) return "VAGUE_JD";
  if (normalizedSignal.includes("requirements realism")) return "UNREALISTIC_REQUIREMENTS";
  if (normalizedSignal.includes("salary")) return "SALARY_UNCLEAR";
  return signal.signal.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function computeConfidence(params: { jdTermCount: number; skillTermsCount: number; riskScore: number }): "LOW" | "MEDIUM" | "HIGH" {
  const { jdTermCount, skillTermsCount, riskScore } = params;
  const signalDensity = jdTermCount > 0 ? skillTermsCount / jdTermCount : 0;
  if (jdTermCount < 15) return "LOW";
  if (skillTermsCount < 3) return "LOW";
  if (signalDensity < 0.1) return "LOW";
  if (riskScore > 0.6) return "MEDIUM";
  return "HIGH";
}

type ScoreImpact = "LOW" | "MEDIUM" | "HIGH";

function getImpact(value: number): ScoreImpact {
  if (value < 0.4) return "LOW";
  if (value < 0.7) return "MEDIUM";
  return "HIGH";
}

export interface ScoreBreakdownVerbose {
  skill_match: { value: number; impact: ScoreImpact };
  keyword_overlap: { value: number; impact: ScoreImpact };
  experience_match: { value: number; impact: ScoreImpact };
  risk_score: { value: number; impact: "NEGATIVE" };
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function computeRiskScore(ghostRisk: GhostRiskResult): number {
  const signalCount = ghostRisk.signals.length || 1;
  const concerningCount = ghostRisk.signals.filter((signal) => signal.weight === "Concerning").length;
  const concerningRatio = concerningCount / signalCount;

  const tierBase =
    ghostRisk.legitimacyTier === "Suspicious" ? 0.85 :
    ghostRisk.legitimacyTier === "Proceed with Caution" ? 0.5 : 0.15;

  return clampUnit((tierBase * 0.7) + (concerningRatio * 0.3));
}

function extractRequiredYears(jdText: string): number | null {
  const matches = [...jdText.matchAll(/(\d+)\s*\+?\s*years?/gi)];
  if (!matches.length) return null;
  const years = matches.map((entry) => Number(entry[1])).filter((value) => Number.isFinite(value));
  if (!years.length) return null;
  return Math.max(...years);
}

function inferProfileYears(profileText: string): number {
  const matches = [...profileText.matchAll(/(\d+)\s*\+?\s*years?/gi)];
  const parsedYears = matches.map((entry) => Number(entry[1])).filter((value) => Number.isFinite(value));
  if (parsedYears.length > 0) return Math.max(...parsedYears);

  const words = profileText.split(/\s+/).filter(Boolean).length;
  if (words >= 700) return 5;
  if (words >= 400) return 3;
  if (words >= 200) return 2;
  return 1;
}

function buildAnalysisReasons(params: {
  cvMatch: CvMatchResult;
  keywords: string[];
  profileText: string;
  ghostRisk: GhostRiskResult;
  jdText: string;
}): AnalysisReasons {
  const { cvMatch, keywords, profileText, ghostRisk, jdText } = params;
  const profileLower = profileText.toLowerCase();
  const jdLower = jdText.toLowerCase();

  const missing_skills = rankMissingSkills(cvMatch, jdText, 5);

  const requiredYears = extractRequiredYears(jdText);
  const profileYears = inferProfileYears(profileText);
  const experience_gap = requiredYears && profileYears < requiredYears
    ? `Requires ${requiredYears}+ years, profile suggests ~${profileYears} year${profileYears === 1 ? "" : "s"}`
    : null;

  const keyword_mismatch = keywords
    .filter((keyword) => {
      const normalized = keyword.toLowerCase();
      const frequency = countTermFrequencyInText(jdLower, normalized);
      const important = IMPORTANT_KEYWORDS.includes(normalized);
      const isSoft = SOFT_WORDS.includes(normalized);
      return !isSoft && (frequency >= 2 || important) && !profileLower.includes(normalized);
    })
    .slice(0, 8);

  const risk_summary = ghostRisk.signals
    .filter((signal) => signal.weight !== "Positive")
    .slice(0, 6)
    .map((signal) => ({ type: toRiskType(signal), message: signal.finding }));

  const risk_summary_text = risk_summary.map((item) => `${item.type}: ${item.message}`);

  return {
    missing_skills: missing_skills.map(formatTokenForDisplay),
    experience_gap,
    keyword_mismatch: keyword_mismatch.map(formatTokenForDisplay),
    risk_summary,
    risk_summary_text,
  };
}

// ─────────────────────────────────────────────────────────────
// Flat Analysis Object (top-level pipeline-friendly output)
// ─────────────────────────────────────────────────────────────

export interface JobAnalysisSummary {
  score: number;                // 0-100
  match_score: number;          // 0-100 (CV match only)
  confidence: "LOW" | "MEDIUM" | "HIGH";
  auto_apply_threshold: number;
  tailoring_triggered: boolean;
  tailoring_missing_skills: string[];
  tailored_resume?: TailoredResume | null;
  decision: ApplyDecision;
  apply_priority: ApplyPriority;
  matched_skills: string[];
  missing_skills: string[];
  risk_flags: RiskFlag[];
  score_breakdown: ScoreBreakdown;
  score_breakdown_verbose: ScoreBreakdownVerbose;
  reasons: AnalysisReasons;
}

const AUTO_APPLY_THRESHOLD = Number(process.env.AUTO_APPLY_THRESHOLD ?? "70");

/**
 * Build the flat analysis summary from all computed sub-results.
 * This is what the automated pipeline consumes.
 */
export function buildAnalysisSummary(params: {
  cvMatch: CvMatchResult;
  ghostRisk: GhostRiskResult;
  keywords: string[];
  profileText: string;
  jdText: string;
  remotePolicy: RemotePolicy;
  seniority: Seniority;
  jdSkillCount: number;
}): JobAnalysisSummary {
  const {
    cvMatch,
    ghostRisk,
    keywords,
    profileText,
    jdText,
    remotePolicy,
    seniority,
    jdSkillCount,
  } = params;

  const match_score = normalizeScore(cvMatch.matchScoreEstimate);

  const score_breakdown = computeScoreBreakdown({
    cvMatch,
    keywords,
    profileText,
    seniority,
  });

  const risk_score = computeRiskScore(ghostRisk);
  const finalScore =
    (0.4 * score_breakdown.skill_match) +
    (0.25 * score_breakdown.keyword_overlap) +
    (0.2 * score_breakdown.experience_match) +
    (0.15 * (1 - risk_score));

  const score_breakdown_verbose: ScoreBreakdownVerbose = {
    skill_match: {
      value: score_breakdown.skill_match,
      impact: getImpact(score_breakdown.skill_match)
    },
    keyword_overlap: {
      value: score_breakdown.keyword_overlap,
      impact: getImpact(score_breakdown.keyword_overlap)
    },
    experience_match: {
      value: score_breakdown.experience_match,
      impact: getImpact(score_breakdown.experience_match)
    },
    risk_score: {
      value: risk_score,
      impact: "NEGATIVE"
    }
  };

  const score = Math.round(clampUnit(finalScore) * 100);
  const jdTermCount = new Set(jdText.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length >= 3)).size;
  const skillTermsCount = jdSkillCount;
  const confidence = computeConfidence({ jdTermCount, skillTermsCount, riskScore: risk_score });
  const decision = computeDecision(score);
  const apply_priority = computePriority(score);
  const tailoring_triggered = score >= AUTO_APPLY_THRESHOLD;

  const matched_skills = cvMatch.matchedSkills
    .filter((s) => s.matchedInProfile)
    .map((s) => s.skill);

  const missing_skills = rankMissingSkills(cvMatch, jdText, 5);
  const tailoring_missing_skills = missing_skills.map(formatTokenForDisplay).slice(0, 5);

  const risk_flags = extractRiskFlags({
    score,
    ghostRisk,
    cvMatch,
    remotePolicy,
    seniority,
    jdSkillCount,
  });

  const reasons = buildAnalysisReasons({
    cvMatch,
    keywords,
    profileText,
    ghostRisk,
    jdText,
  });

  return {
    score,
    match_score,
    confidence,
    auto_apply_threshold: AUTO_APPLY_THRESHOLD,
    tailoring_triggered,
    tailoring_missing_skills,
    tailored_resume: null,
    decision,
    apply_priority,
    matched_skills,
    missing_skills,
    risk_flags,
    score_breakdown,
    score_breakdown_verbose,
    reasons,
  };
}
