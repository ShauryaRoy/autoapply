# Job Intelligence Port — Implementation Notes

> **Date:** 2026-04-12
> **Author:** Antigravity (automated port from Career-Ops)

---

## What Was Done

A full port of the Career-Ops job-analysis pipeline into the AutoApply Express API as a clean, typed, stateless service — **no CLI, no file I/O, no markdown storage**.

---

## New Files

| File | Purpose |
|------|---------|
| `apps/api/src/services/jobIntelligenceService.ts` | Pure-logic service — all ported intelligence functions |
| `apps/api/src/routes/job.ts` | Express router exposing `POST /api/job/analyze` |

## Modified Files

| File | Change |
|------|--------|
| `apps/api/src/app.ts` | Added `import { createJobRouter }` + registered `app.use("/api/job", authRequired, createJobRouter())` |

---

## API Endpoint

### `POST /api/job/analyze`

**Auth:** Bearer JWT required.

**Request Body:**

```json
{
  "jobDescription": "string (min 50 chars, required)",
  "companyName": "string (optional)",
  "jobTitle": "string (optional)",
  "profileText": "string — resume/profile text for CV matching (optional)",
  "profileSkills": ["Python", "React"],
  "ghostRiskHints": {
    "postingAgeDays": 12,
    "hasApplyButton": true,
    "repostCount": 0
  },
  "preferredRemotePolicies": ["fully-remote"]
}
```

**Response:**

```json
{
  "roleSummary": {
    "archetype": "AI Platform / LLMOps",
    "secondaryArchetype": "Agentic / Automation",
    "seniority": "Senior",
    "remotePolicy": "fully-remote",
    "domain": "Generative AI",
    "function": "build",
    "tldr": "Senior ML Engineer at Acme AI (AI Platform / LLMOps), fully remote."
  },
  "requiredSkills": ["Python", "PyTorch", "LangChain"],
  "preferredSkills": ["Go", "Kubernetes"],
  "keywords": ["RAG", "LLM", "evals", "Python", "PyTorch"],
  "cvMatch": {
    "matchedSkills": [
      { "skill": "Python", "weight": "required", "matchedInProfile": true },
      { "skill": "Go", "weight": "preferred", "matchedInProfile": false }
    ],
    "gaps": [
      {
        "requirement": "Go",
        "severity": "nice-to-have",
        "mitigation": "Go is preferred but not blocking. Mention any adjacent experience."
      }
    ],
    "matchScoreEstimate": 4.2
  },
  "ghostRisk": {
    "legitimacyTier": "High Confidence",
    "signals": [
      { "signal": "Posting freshness", "finding": "Fresh (12 days old)", "weight": "Positive" },
      { "signal": "Apply button", "finding": "Visible and active", "weight": "Positive" }
    ],
    "contextNotes": []
  },
  "overallScore": 4.1,
  "scoreInterpretation": "Good match — worth applying"
}
```

---

## Logic Sources (Career-Ops → AutoApply mapping)

| Career-Ops Source | AutoApply Function | Block |
|---|---|---|
| `modes/_shared.md` § Archetype Detection table | `detectArchetype()` | A |
| `analyze-patterns.mjs` § `extractBlockerType` | `detectSeniority()` | A |
| `analyze-patterns.mjs` § `classifyRemote` | `detectRemotePolicy()` | A |
| `modes/oferta.md` § Bloque B CV Match logic | `matchCvToJd()` | B |
| `analyze-patterns.mjs` § `techStackGaps` | `extractSkills()` | B |
| `modes/oferta.md` § Bloque G Posting Legitimacy | `analyzeGhostRisk()` | G |
| `liveness-core.mjs` § `HARD_EXPIRED_PATTERNS` | `analyzeGhostRisk()` | G |
| `modes/_shared.md` § Scoring System | `computeOverallScore()` | Score |

---

## What Was NOT Ported (Intentionally Excluded)

| Career-Ops Feature | Reason Excluded |
|---|---|
| CLI argument parsing (`process.argv`) | API-only service |
| Markdown report file writer | No file system in API |
| `applications.md` / `pipeline.md` tracker | Replaced by Prisma DB |
| PDF generation (`generate-pdf.mjs`) | Separate concern |
| STAR interview prep (Block F) | Future TODO |
| Cover letter personalisation (Block E) | Future TODO |
| Comp/salary research (Block D) | Requires external API calls |
| Portal scanning (`scan.mjs`) | Scanner separate from analysis |
| Status normalisation + funnel analysis | Requires historical data store |
| Archetype-specific proof point injection | Requires user narrative context |

---

## Scoring System (from Career-Ops `_shared.md`)

| Score | Interpretation |
|---|---|
| 4.5 + | Strong match — apply immediately |
| 4.0 – 4.4 | Good match — worth applying |
| 3.5 – 3.9 | Decent — apply only if specific reason |
| < 3.5 | Below threshold — consider skipping |

### Score Components

- **CV Match (70%)** — required skill coverage × 3.5 + preferred skill coverage × 1.5
- **Remote Policy Penalty** — −0.5 for onsite mismatch, −0.8 for geo-restricted
- **Ghost Risk Penalty** — −0.5 if Suspicious, −0.2 if Proceed with Caution

---

## Ghost Risk Tiers (Block G)

| Tier | Meaning |
|---|---|
| High Confidence | Multiple positive signals — real active opening |
| Proceed with Caution | Mixed signals — worth noting before investing time |
| Suspicious | Multiple ghost indicators — investigate before applying |

### Signals Checked

1. Posting freshness (from `ghostRiskHints.postingAgeDays`)
2. Apply button state (from `ghostRiskHints.hasApplyButton`)
3. Hard-expired content patterns (regex scan on JD text)
4. Technology specificity in JD
5. Requirements realism (contradictions like entry-level title + 8+ years)
6. Generic boilerplate ratio
7. Reposting count (from `ghostRiskHints.repostCount`)
8. Evergreen/continuous-hire language
9. Salary transparency
10. First-90-days scope clarity

---

## Future Extensions

- **Block E (CV Personalisation):** Accept user's current CV text; return diff of suggested bullet rewrites
- **Block F (Interview Prep):** Generate STAR stories mapped to matched JD requirements
- **Block D (Comp Research):** Hook into Levels.fyi / Glassdoor API for market data
- **Portal Scanner:** Port `scan.mjs` as a background BullMQ job that populates a `jobs` table, enabling `/api/job/pipeline` listing

---

## Refactor Changes

> **Date:** 2026-04-12 (second pass)

### What Changed

No existing intelligence functions were modified. All changes were **additive** — new functions appended to the service, response shape updated in the route only.

---

### 1. Score Normalisation

The internal 0–5 score from `computeOverallScore()` is now converted to a 0–100 integer via:

```ts
score = Math.round((overallScore / 5) * 100)
```

Exposed as `analysis.score`. The raw 0–5 is no longer in the response top-level; it flows internally through `buildAnalysisSummary()`.

**Reason:** 0–100 is the natural scale for automated pipelines. Thresholds like 70 / 40 are immediately human-readable without needing a scoring rubric open.

---

### 2. Apply Decision Engine

```ts
if (score >= 70) decision = "APPLY"
else if (score >= 40) decision = "RISKY"
else decision = "SKIP"
```

Exposed as `analysis.decision`. Three-state enum: `APPLY | RISKY | SKIP`.

**Reason:** A pipeline needs a single machine-readable apply/skip signal, not a prose interpretation string. Removes the ambiguity of "Decent match — apply only if specific reason."

---

### 3. Apply Priority Bands

```ts
if (score >= 80) priority = "HIGH"
else if (score >= 60) priority = "MEDIUM"
else priority = "LOW"
```

Exposed as `analysis.apply_priority`. Allows the pipeline to prioritise the APPLY queue (eg. process HIGH first, batch MEDIUM overnight).

---

### 4. New Response Shape

Old flat structure replaced with three-key envelope:

```json
{
  "job":      { ... },   // lightweight identity — safe to store/index
  "analysis": { ... },   // machine-friendly decision block
  "details":  { ... }    // full intelligence — for UI + human review
}
```

`details.cvMatch` retains the original fields (`matchedSkills`, `gaps`, `matchScoreEstimate`) plus a new `match_score` alias (0-100).

---

### 5. CV Match Score Normalisation

`matchScoreEstimate` (0–5) kept in `details.cvMatch` for backward compatibility.  
New `match_score` (0–100) added to both `analysis` and `details.cvMatch`:

```ts
match_score = Math.round((matchScoreEstimate / 5) * 100)
```

**Reason:** Consistent scale across all score fields in the response.

---

### 6. Score Breakdown (sub-scores)

`analysis.score_breakdown` exposes three transparency sub-scores (all 0–100):

| Field | What it measures |
|---|---|
| `skill_match` | % of JD-required/preferred tech skills found in profile |
| `keyword_overlap` | % of domain keywords (RAG, LLM, evals…) found in profile text |
| `experience_match` | Heuristic: profile depth × seniority inverse weight |

These are **explanatory**, not additive to the main score. They help a UI show "why did I score 62?" without surfacing the raw Career-Ops sub-scores.

---

### 7. Risk Flags

`analysis.risk_flags` is a string array of machine-readable flags derived from `ghostRisk` signals and `cvMatch` gaps:

| Flag | Trigger |
|---|---|
| `LOW_MATCH` | `score < 50` |
| `POSSIBLE_GHOST` | `legitimacyTier === "Suspicious"` |
| `REPOSTED` | Reposting signal is Concerning |
| `VAGUE_JD` | Fewer than 2 tech skills found in JD |
| `GEO_RESTRICTED` | `remotePolicy === "geo-restricted"` |
| `ONSITE_ONLY` | `remotePolicy === "onsite"` |
| `HARD_SKILL_GAP` | At least one `hard-blocker` gap in cvMatch |
| `SENIORITY_MISMATCH` | Role is Director+/Staff and score < 60 |

**Reason:** Flags let the pipeline route jobs to different queues (eg. skip `POSSIBLE_GHOST`, review manually if `HARD_SKILL_GAP`).

---

### New Functions Added (service layer)

| Function | Purpose |
|---|---|
| `normalizeScore(overallScore)` | Converts 0-5 → 0-100 |
| `computeDecision(score)` | Returns APPLY / RISKY / SKIP |
| `computePriority(score)` | Returns HIGH / MEDIUM / LOW |
| `extractRiskFlags(params)` | Produces flat string flag array |
| `computeScoreBreakdown(params)` | Produces 3 transparency sub-scores |
| `buildAnalysisSummary(params)` | Assembles the full `analysis` block |

### Updated Response Shape (full example)

```json
{
  "job": {
    "title": "Senior ML Engineer",
    "company": "Acme AI",
    "remotePolicy": "fully-remote",
    "archetype": "AI Platform / LLMOps",
    "seniority": "Senior",
    "domain": "Generative AI",
    "tldr": "Senior Senior ML Engineer at Acme AI (AI Platform / LLMOps), fully remote."
  },
  "analysis": {
    "score": 82,
    "match_score": 84,
    "decision": "APPLY",
    "apply_priority": "HIGH",
    "matched_skills": ["Python", "PyTorch"],
    "missing_skills": ["Go"],
    "risk_flags": [],
    "score_breakdown": {
      "skill_match": 85,
      "keyword_overlap": 80,
      "experience_match": 65
    }
  },
  "details": {
    "roleSummary": { "...": "..." },
    "requiredSkills": ["Python", "PyTorch", "LangChain"],
    "preferredSkills": ["Go"],
    "keywords": ["RAG", "LLM", "evals", "Python"],
    "cvMatch": {
      "matchedSkills": [ "..." ],
      "gaps": [ "..." ],
      "matchScoreEstimate": 4.2,
      "match_score": 84
    },
    "ghostRisk": {
      "legitimacyTier": "High Confidence",
      "signals": [ "..." ],
      "contextNotes": []
    }
  }
}
```

