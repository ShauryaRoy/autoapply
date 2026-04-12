/**
 * bulletMatcher.ts
 *
 * Analyses a single resume bullet against JD requirements.
 * Adapted from Career-Ops Block B (CV ↔ JD matching) and pdf.md
 * keyword injection strategy.
 *
 * Key principles from Career-Ops:
 *  - Map JD keywords to EXISTING content — never invent
 *  - Required skills are weighted 70%, preferred 30%
 *  - Identify "reformulation opportunities": same concept, different vocabulary
 *  - A keyword is "injectable" only when the bullet's domain already touches it
 */

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface BulletMatchResult {
  /** JD keywords already present in the bullet (exact or near-match) */
  present: string[];
  /** JD keywords absent from bullet but semantically adjacent */
  injectable: string[];
  /** JD keywords absent and with no semantic proximity — skip */
  irrelevant: string[];
  /** True when the bullet has at least one present or injectable keyword */
  hasPatchOpportunity: boolean;
  /** Bullet domain cluster (used to fence hallucination in the LLM prompt) */
  detectedDomain: BulletDomain;
}

export type BulletDomain =
  | "engineering"
  | "data-ml"
  | "product"
  | "leadership"
  | "infrastructure"
  | "generic";

// ─────────────────────────────────────────────────────────────
// Domain detection
// Mirrors Career-Ops archetype signals but at bullet granularity
// ─────────────────────────────────────────────────────────────

const DOMAIN_SIGNALS: { domain: BulletDomain; patterns: RegExp[] }[] = [
  {
    domain: "data-ml",
    patterns: [
      /\b(model|train|inference|embedding|vector|pipeline|dataset|fine[- ]tun|LLM|RAG|NLP|ML|AI|neural|predict|classif|regress|feature|eval|accuracy|precision|recall|F1)\b/i,
    ],
  },
  {
    domain: "infrastructure",
    patterns: [
      /\b(deploy|infrastructure|CI[\/\-]CD|container|kubernetes|docker|terraform|helm|cloud|AWS|GCP|Azure|SRE|monitor|uptime|latency|throughput|scale|redis|queue|kafka)\b/i,
    ],
  },
  {
    domain: "product",
    patterns: [
      /\b(product|roadmap|stakeholder|OKR|discovery|launch|sprint|agile|user\s*research|A\/B|metric|KPI|feature\s*flag|prioriti)\b/i,
    ],
  },
  {
    domain: "leadership",
    patterns: [
      /\b(led|managed|mentored|hired|team|report|cross[- ]functional|executive|strategy|org|headcount|review|1:1|coaching)\b/i,
    ],
  },
  {
    domain: "engineering",
    patterns: [
      /\b(built|developed|implemented|engineered|refactor|architect|API|backend|frontend|database|schema|service|module|library|SDK|integration|endpoint)\b/i,
    ],
  },
];

export function detectBulletDomain(bullet: string): BulletDomain {
  for (const { domain, patterns } of DOMAIN_SIGNALS) {
    if (patterns.some((p) => p.test(bullet))) return domain;
  }
  return "generic";
}

// ─────────────────────────────────────────────────────────────
// Semantic adjacency map
// Career-Ops pdf.md: "reformulation opportunities" —
// same concept, different vocabulary.
// Only map → reformulate when the bullet's existing language fits.
// ─────────────────────────────────────────────────────────────

type Synonyms = Record<string, string[]>;

const SEMANTIC_SYNONYMS: Synonyms = {
  // LLM / AI
  "RAG": ["retrieval", "retrieval-augmented", "document search", "context injection", "vector search"],
  "LLM": ["large language model", "GPT", "Claude", "Gemini", "language model", "foundation model"],
  "MLOps": ["model deployment", "observability", "evals", "model monitoring", "model serving"],
  "LangChain": ["LLM workflow", "chain", "agent framework"],
  "fine-tuning": ["fine-tuned", "PEFT", "LoRA", "domain adaptation", "model training"],
  "embeddings": ["vector", "semantic search", "similarity", "encoding"],
  "RAG pipeline": ["retrieval pipeline", "search pipeline", "document retrieval"],
  // Engineering
  "REST API": ["API", "endpoint", "HTTP service", "web service"],
  "microservices": ["service", "modular", "distributed", "services architecture"],
  "CI/CD": ["continuous integration", "continuous deployment", "automated pipeline", "GitHub Actions", "CircleCI"],
  "Kubernetes": ["container orchestration", "k8s", "pod", "cluster"],
  "Docker": ["containers", "containerized"],
  // Soft / process
  "stakeholder management": ["collaborated with", "cross-functional", "partnered with", "worked with"],
  "scalability": ["scaled", "scale", "high throughput", "performance"],
  "observability": ["monitoring", "logging", "tracing", "metrics"],
};

/**
 * Check if a JD keyword has a semantic synonym present in the bullet.
 * Returns the matched synonym if found, null otherwise.
 */
function findSemanticMatch(keyword: string, bulletLower: string): string | null {
  const kwLower = keyword.toLowerCase();

  // Direct containment
  if (bulletLower.includes(kwLower)) return keyword;

  // Synonym table lookup
  const entry = Object.entries(SEMANTIC_SYNONYMS).find(
    ([canonical]) => canonical.toLowerCase() === kwLower
  );
  if (entry) {
    const synonym = entry[1].find((s) => bulletLower.includes(s.toLowerCase()));
    if (synonym) return synonym;
  }

  // Reverse lookup: is this keyword a synonym for something already in the bullet?
  for (const [canonical, synonyms] of Object.entries(SEMANTIC_SYNONYMS)) {
    if (synonyms.some((s) => s.toLowerCase() === kwLower)) {
      if (bulletLower.includes(canonical.toLowerCase())) return canonical;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Domain fence check
// A keyword is "injectable" only if it belongs to the same
// domain cluster as the bullet — prevents hallucination.
// ─────────────────────────────────────────────────────────────

const DOMAIN_KEYWORD_CLUSTERS: Record<BulletDomain, RegExp[]> = {
  "data-ml": [
    /\b(RAG|LLM|MLOps|embedding|vector|model|pipeline|inference|eval|NLP|ML|AI|fine[- ]tun|dataset|training)\b/i,
  ],
  "infrastructure": [
    /\b(CI\/CD|docker|kubernetes|terraform|cloud|AWS|GCP|Azure|deploy|scale|redis|kafka|monitor|SRE|infra)\b/i,
  ],
  "product": [
    /\b(roadmap|OKR|sprint|discovery|metric|KPI|A\/B|feature|stakeholder|launch|agile)\b/i,
  ],
  "leadership": [
    /\b(team|mentoring|hiring|strategy|cross[- ]functional|executive|review|coaching|organization)\b/i,
  ],
  "engineering": [
    /\b(API|backend|frontend|database|service|integration|architecture|refactor|endpoint|module|SDK|library)\b/i,
  ],
  "generic": [],
};

function isKeywordInDomain(keyword: string, domain: BulletDomain): boolean {
  if (domain === "generic") return true; // generic bullets can accept any keyword
  const patterns = DOMAIN_KEYWORD_CLUSTERS[domain];
  return patterns.some((p) => p.test(keyword));
}

// ─────────────────────────────────────────────────────────────
// Main matching function
// Source inspiration: Career-Ops Block B matchCvToJd logic
// ─────────────────────────────────────────────────────────────

export function matchBulletToJd(
  bullet: string,
  jdKeywords: string[]
): BulletMatchResult {
  const bulletLower = bullet.toLowerCase();
  const detectedDomain = detectBulletDomain(bullet);

  const present: string[] = [];
  const injectable: string[] = [];
  const irrelevant: string[] = [];

  for (const keyword of jdKeywords) {
    const semanticMatch = findSemanticMatch(keyword, bulletLower);

    if (semanticMatch) {
      // Keyword is already expressed (directly or via synonym)
      present.push(keyword);
    } else if (isKeywordInDomain(keyword, detectedDomain)) {
      // Keyword missing but domain-compatible → safe to inject
      injectable.push(keyword);
    } else {
      // Out of domain — do not inject (would hallucinate context)
      irrelevant.push(keyword);
    }
  }

  return {
    present,
    injectable,
    irrelevant,
    hasPatchOpportunity: present.length > 0 || injectable.length > 0,
    detectedDomain,
  };
}
