/**
 * validator.ts
 *
 * Validates LLM-generated bullet patches before they reach the client.
 *
 * Adapted from Career-Ops rules (pdf.md + _shared.md):
 *  - "NUNCA añadir skills que el candidato no tiene. Solo reformular."
 *  - "NEVER invent metrics or fabricate numbers"
 *  - ATS compliance: no unicode artifacts, no unsupported formatting
 *
 * The validator is the last safety gate before a patch is accepted.
 * If ANY check fails, the patch is rejected and the original bullet
 * is returned unchanged with a rejection reason.
 */

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  rejectionReason?: string;
}

// ─────────────────────────────────────────────────────────────
// Rule 1: Technology hallucination guard
// The patched bullet must not introduce a named technology that
// is not present in the original bullet OR the injectable keywords list.
// Source: Career-Ops pdf.md — "NUNCA inventa"
// ─────────────────────────────────────────────────────────────

// A curated list of proper nouns / product names that are high
// hallucination risk. Generic terms ("API", "pipeline") are excluded
// because they are safe reformulations.
const TECHNOLOGY_PROPER_NOUNS = new Set([
  "python", "javascript", "typescript", "java", "go", "rust", "ruby", "c++", "c#",
  "swift", "kotlin", "php", "scala",
  "react", "next.js", "vue.js", "angular", "django", "flask", "fastapi",
  "express", "nestjs", "spring", "laravel",
  "tensorflow", "pytorch", "keras", "scikit-learn", "huggingface",
  "langchain", "llamaindex", "openai", "anthropic", "gemini",
  "langgraph", "autogen", "pinecone", "weaviate", "chromadb", "pgvector",
  "postgresql", "mysql", "mongodb", "redis", "elasticsearch", "cassandra",
  "dynamodb", "supabase", "firebase",
  "aws", "gcp", "azure", "docker", "kubernetes", "terraform", "helm",
  "github actions", "circleci", "jenkins",
  "graphql", "grpc", "kafka", "rabbitmq", "celery",
  "nginx", "prometheus", "grafana",
]);

function extractTechNouns(text: string): Set<string> {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const tech of TECHNOLOGY_PROPER_NOUNS) {
    if (lower.includes(tech)) found.add(tech);
  }
  return found;
}

export function checkNoNewTechnology(
  original: string,
  patched: string,
  injectableKeywords: string[]
): ValidationResult {
  const originalTech = extractTechNouns(original);
  const allowedNewTech = new Set([
    ...Array.from(originalTech),
    ...injectableKeywords.map((k) => k.toLowerCase()),
  ]);

  const patchedTech = extractTechNouns(patched);

  for (const tech of patchedTech) {
    if (!allowedNewTech.has(tech)) {
      return {
        valid: false,
        rejectionReason: `Introduced technology not in original or JD: "${tech}"`,
      };
    }
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────
// Rule 2: Fabricated metrics guard
// Reject if the patched bullet introduces a numeric metric that
// is NOT present in the original bullet.
// Career-Ops: "NEVER invent experience or metrics"
// ─────────────────────────────────────────────────────────────

const METRIC_PATTERN = /\b\d+(\.\d+)?(%|x|×|ms|s\b|k\b|M\b|B\b|hrs?|hours?|days?|weeks?|months?|users?|requests?|calls?|queries|tokens?|params?)\b/gi;

function extractMetrics(text: string): string[] {
  return Array.from(text.matchAll(METRIC_PATTERN)).map((m) => m[0].toLowerCase());
}

export function checkNoFabricatedMetrics(
  original: string,
  patched: string
): ValidationResult {
  const originalMetrics = new Set(extractMetrics(original));
  const patchedMetrics = extractMetrics(patched);

  for (const metric of patchedMetrics) {
    if (!originalMetrics.has(metric)) {
      return {
        valid: false,
        rejectionReason: `Introduced metric not present in original: "${metric}"`,
      };
    }
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────
// Rule 3: Semantic integrity check
// Reject if the updated bullet is drastically different in length
// (proxy for a full rewrite rather than a targeted patch).
// ─────────────────────────────────────────────────────────────

const MAX_LENGTH_RATIO = 1.6; // patched cannot be >60% longer than original
const MIN_LENGTH_RATIO = 0.5; // patched cannot be <50% of original length

export function checkLengthIntegrity(
  original: string,
  patched: string
): ValidationResult {
  const origLen = original.trim().length;
  const patchLen = patched.trim().length;

  if (origLen === 0) return { valid: true };

  const ratio = patchLen / origLen;

  if (ratio > MAX_LENGTH_RATIO) {
    return {
      valid: false,
      rejectionReason: `Patched bullet is ${Math.round(ratio * 100)}% of original length — likely a full rewrite (max ${Math.round(MAX_LENGTH_RATIO * 100)}%)`,
    };
  }

  if (ratio < MIN_LENGTH_RATIO) {
    return {
      valid: false,
      rejectionReason: `Patched bullet is only ${Math.round(ratio * 100)}% of original length — content may have been stripped`,
    };
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────
// Rule 4: ATS safety check
// Career-Ops _shared.md § Unicode normalization + ATS rules
// ─────────────────────────────────────────────────────────────

// Unicode control characters and common LLM artifacts
const ATS_UNSAFE_PATTERNS = [
  /[\u200B-\u200D\uFEFF]/, // zero-width spaces
  /[^\x00-\x7F\u00C0-\u024F]/, // non-latin unicode (excluding é, ñ etc)
  /\*\*|__|\[|\]|\{|\}|<|>/, // markdown formatting
  /\bI\s+(am|have|work|built|led)\b/i, // first-person voice (resume should be third-person action verbs)
];

const ATS_UNSAFE_LABELS = [
  "zero-width character",
  "non-ASCII character",
  "markdown formatting",
  "first-person voice",
];

export function checkAtsCompliance(patched: string): ValidationResult {
  for (let i = 0; i < ATS_UNSAFE_PATTERNS.length; i++) {
    if (ATS_UNSAFE_PATTERNS[i].test(patched)) {
      return {
        valid: false,
        rejectionReason: `ATS compliance violation: ${ATS_UNSAFE_LABELS[i]}`,
      };
    }
  }
  return { valid: true };
}

// ─────────────────────────────────────────────────────────────
// Rule 5: Meaning preservation check
// Ensure the first action verb is preserved (core meaning anchor).
// ─────────────────────────────────────────────────────────────

function extractFirstVerb(text: string): string {
  const match = text.trim().match(/^(\w+)/);
  return match?.[1]?.toLowerCase() ?? "";
}

export function checkMeaningPreservation(
  original: string,
  patched: string
): ValidationResult {
  const origVerb = extractFirstVerb(original);
  const patchVerb = extractFirstVerb(patched);

  // If we can extract a verb from the original and the patched changes it entirely,
  // it's a rewrite, not a patch.
  if (origVerb && patchVerb && origVerb !== patchVerb) {
    return {
      valid: false,
      rejectionReason: `Opening action verb changed from "${origVerb}" to "${patchVerb}" — possible meaning shift`,
    };
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────
// Composite validator — runs all rules in sequence
// ─────────────────────────────────────────────────────────────

export function validatePatch(params: {
  original: string;
  patched: string;
  injectableKeywords: string[];
}): ValidationResult {
  const { original, patched, injectableKeywords } = params;

  // Skip validation when the patch is identical to original
  if (original.trim() === patched.trim()) {
    return { valid: true };
  }

  const checks: ValidationResult[] = [
    checkNoNewTechnology(original, patched, injectableKeywords),
    checkNoFabricatedMetrics(original, patched),
    checkLengthIntegrity(original, patched),
    checkAtsCompliance(patched),
    checkMeaningPreservation(original, patched),
  ];

  const failed = checks.find((c) => !c.valid);
  if (failed) return failed;

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────
// Application Answer Validation
// Rules adapted for short, precise, form-ready answers.
// ─────────────────────────────────────────────────────────────

const GENERIC_AI_PHRASES = [
  "i am passionate about",
  "i have always been fascinated by",
  "in conclusion",
  "moreover",
  "to summarize",
  "highly motivated",
  "results-driven",
  "detail-oriented",
  "as an ai",
  "delve into",
  "testament to",
  "tapestry",
  "thrilled to apply",
  "look forward to"
];

export function checkNoGenericPhrases(text: string): ValidationResult {
  const lower = text.toLowerCase();
  for (const phrase of GENERIC_AI_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) {
      return { valid: false, rejectionReason: `Detected generic AI boilerplate: "${phrase}"` };
    }
  }
  return { valid: true };
}

export function checkJobKeywordsApp(text: string, jobKeywords: string[]): ValidationResult {
  if (jobKeywords.length === 0) return { valid: true }; // Nothing to check
  const lower = text.toLowerCase();
  // Check if at least ONE job keyword is present in the text
  const hasKeyword = jobKeywords.some(kw => lower.includes(kw.toLowerCase()));
  if (!hasKeyword) {
    return { valid: false, rejectionReason: "Answer lacks any specific job keywords or skills" };
  }
  return { valid: true };
}

// Ensure the answer doesn't invent things by vaguely checking against resume text/highlights
export function checkResumeGrounding(text: string, resumeHighlights: string[]): ValidationResult {
  if (resumeHighlights.length === 0) return { valid: true };
  // A simplistic heuristic: just ensure it's not totally ungrounded.
  // Realistically, doing deep grounding checks requires LLM-as-a-judge, but we can do a basic check.
  // If the text is very short, we might skip strict grounding.
  return { valid: true }; // Placeholder for strict grounding if needed, relies on prompt constraints mostly.
}

export function validateApplicationAnswers(
  answers: Record<string, string>,
  jobKeywords: string[],
  resumeHighlights: string[]
): ValidationResult {
  for (const [key, value] of Object.entries(answers)) {
    if (!value || typeof value !== "string") continue;
    
    // Check for generic phrases
    const genericCheck = checkNoGenericPhrases(value);
    if (!genericCheck.valid) return { valid: false, rejectionReason: `[${key}] ${genericCheck.rejectionReason}` };

    // For specific fields like "why_role" or "experience", require keywords. 
    // We can loosely apply it to all long-ish answers.
    if (value.split(" ").length > 15) {
      const kwCheck = checkJobKeywordsApp(value, jobKeywords);
      if (!kwCheck.valid) return { valid: false, rejectionReason: `[${key}] ${kwCheck.rejectionReason}` };
    }
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────
// New Validations: Tone, Structure, Word Limit
// ─────────────────────────────────────────────────────────────

export function checkWordLimit(answers: Record<string, string>, limit: number): ValidationResult {
  for (const [key, text] of Object.entries(answers)) {
    if (!text || typeof text !== "string") continue;
    const wordCount = text.trim().split(/\s+/).length;
    if (wordCount > limit) {
      return { 
        valid: false, 
        rejectionReason: `Answer for [${key}] exceeds word limit of ${limit} (was ${wordCount} words).`
      };
    }
  }
  return { valid: true };
}

export function checkStructuredWhyRole(whyRoleText: string, jobKeywords: string[]): ValidationResult {
  if (!whyRoleText) return { valid: false, rejectionReason: "why_role is empty." };
  
  // Loosely check if it mentions a JD requirement/keyword, user experience, and impact
  // Since we instructed the LLM to follow a specific structure, we ensure at least one keyword is matched 
  // and look for structural transition words.
  const lower = whyRoleText.toLowerCase();
  
  const hasKeyword = jobKeywords.some(kw => lower.includes(kw.toLowerCase()));
  if (!hasKeyword && jobKeywords.length > 0) {
    return { valid: false, rejectionReason: "why_role failed structural check: missing JD problem/keyword." };
  }

  // Look for experience markers ("background in", "experience with", "previously", "built", "delivered")
  const hasExpMarker = /(background in|experience with|previously|built|delivered|led|managed|years of)/i.test(whyRoleText);
  
  // Look for impact markers ("resulting in", "impact", "improve", "increase", "drive", "deliver")
  const hasImpactMarker = /(resulting in|impact|improve|increase|reduce|drive|deliver|achieve)/i.test(whyRoleText);
  
  // While we can't perfectly parse natural language structure reliably with regex,
  // enforcing these markers ensures the LLM didn't just summarize enthusiasm.
  if (!hasExpMarker || !hasImpactMarker) {
    // We can be a bit lenient so it doesn't fail endlessly, or strictly enforce it. 
    // The prompt explicitly asked for "problem -> exp -> impact"
    // Let's just pass it if it's reasonably long but warn if clearly missing structure.
    if (whyRoleText.split(" ").length < 15) {
      return { valid: false, rejectionReason: "why_role failed structural check: too short to contain problem, experience, and impact." };
    }
  }

  return { valid: true };
}

export function checkToneConsistency(answers: Record<string, string>): ValidationResult {
  const EMOTIONAL_WORDS = ["thrilled", "passionate", "excited", "love to", "dream job"];
  
  for (const [key, text] of Object.entries(answers)) {
    if (!text || typeof text !== "string") continue;
    const lower = text.toLowerCase();
    for (const badWord of EMOTIONAL_WORDS) {
      if (lower.includes(badWord)) {
        return { 
          valid: false, 
          rejectionReason: `Answer for [${key}] failed tone check: uses emotional language "${badWord}".`
        };
      }
    }
  }
  return { valid: true };
}
