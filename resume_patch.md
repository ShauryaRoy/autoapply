# Resume Patch Engine

> **Date:** 2026-04-12
> **Endpoint:** `POST /api/resume/patch`

---

## What Was Learned from Career-Ops

### Block B — CV ↔ JD Matching Logic

Career-Ops `modes/oferta.md` § Bloque B defines the gold standard for matching:

> *"Lee cv.md. Crea tabla con cada requisito del JD mapeado a líneas exactas del CV."*

Key insights extracted:
1. **Required vs preferred weighting** — required skills carry 70% of the match score; preferred carry 30%
2. **Gap classification** — each missing requirement is rated `hard-blocker`, `significant`, or `nice-to-have`
3. **Mitigation strategy** — for every gap, Career-Ops generates a concrete cover-up strategy

### pdf.md — Keyword Injection Strategy

Career-Ops `modes/pdf.md` defines the exact injection philosophy used here:

> *"Inject keywords naturally into existing achievements (NEVER invent)"*

Examples from pdf.md that directly shaped the `SEMANTIC_SYNONYMS` table:

| CV says | JD says | Safe reformulation |
|---|---|---|
| "LLM workflows with retrieval" | "RAG pipelines" | "RAG pipeline design and LLM orchestration" |
| "observability, evals, error handling" | "MLOps" | "MLOps and observability: evals, error handling" |
| "collaborated with team" | "stakeholder management" | "stakeholder management across engineering and ops" |

### _shared.md — Anti-Hallucination Rules

> *"NEVER: Invent experience or metrics"*
> *"ALWAYS: Cite exact lines from CV when matching"*

These rules became hardcoded validation checks in `validator.ts`.

---

## Architecture

```
POST /api/resume/patch
       │
       ▼
routes/resume.ts          ← Input validation (Zod)
       │
       ▼
services/resumePatchService.ts
       │
       ├── utils/bulletMatcher.ts   ← Career-Ops Block B adapted
       │         │
       │         ├── detectBulletDomain()   → engineering / data-ml / product / ...
       │         ├── findSemanticMatch()    → synonym table (from pdf.md examples)
       │         ├── isKeywordInDomain()    → domain fence (hallucination guard)
       │         └── matchBulletToJd()     → present / injectable / irrelevant
       │
       ├── [Gemini LLM]             ← Constrained prompt per bullet
       │
       └── utils/validator.ts       ← 5-rule safety gate
                 ├── checkNoNewTechnology()
                 ├── checkNoFabricatedMetrics()
                 ├── checkLengthIntegrity()
                 ├── checkAtsCompliance()
                 └── checkMeaningPreservation()
```

---

## CV Matching Adaptation

Career-Ops Block B operates on a full CV markdown file against the complete JD text.
The patch engine adapts this to **bullet-granularity**:

| Career-Ops (Block B) | Patch Engine |
|---|---|
| Full CV vs full JD | Single bullet vs JD keywords |
| Skill list match across entire resume | Per-bullet domain detection |
| Gap = "hard-blocker" or "nice-to-have" | Gap = "injectable" or "irrelevant" |
| Output = table of matched/unmatched requirements | Output = `PatchedBullet[]` with diff |
| Human reviews the gaps | Validator auto-rejects bad patches |

**Key adaptation:** Career-Ops identifies gaps for a human to act on. The patch engine identifies injectable keywords and hands them to an LLM with a constrained prompt — the validator then enforces the same rules Career-Ops states as "NEVER".

---

## Prompt Design

### Philosophy

Career-Ops pdf.md says:
> *"Reescribe bullets de experiencia por relevancia al JD"*
> *"Inyecta keywords naturalmente en logros existentes (NUNCA inventa)"*

The LLM is told exactly the same constraints in the prompt. The prompt structure:

```
TASK: Patch this bullet point by injecting missing keywords naturally.

RULES (11 mandatory):
  1. DO NOT rewrite — only enhance
  2. DO NOT introduce new technologies
  3. DO NOT add numbers not in original
  4. DO NOT change opening action verb
  5. DO NOT use markdown
  6. DO NOT use first-person voice
  7. Keep length within 60% of original
  8. Only inject if it fits naturally
  9. Stay within bullet domain: {domain}
  10. Cap injectable keywords at 5
  11. If nothing fits — return original UNCHANGED

CONTEXT:
  Bullet domain: {domain}
  Keywords already present: [...]
  Keywords to inject if natural: [...]

ORIGINAL BULLET:
  {bullet}

OUTPUT: JSON only { "updated_bullet": "...", "keywords_added": [...] }
```

### Why This Structure Works

- **Domain context** prevents the LLM from injecting cloud infrastructure keywords into a product management bullet
- **"Already present" list** prevents duplicate injection
- **Explicit JSON format** makes parsing deterministic
- **Fallback instruction** ("return original UNCHANGED") is the LLM-side soft fallback before the hard validator fallback

---

## Validation Logic

Five sequential checks run on every LLM output before it is accepted:

### Rule 1: No New Technology
Extracts all proper nouns (Python, PyTorch, AWS, etc.) from original and patched.
Any technology in the patch that's not in the original AND not in the injectable keyword list → **REJECT**.

### Rule 2: No Fabricated Metrics
Extracts all numeric+unit patterns (`85%`, `2x`, `400ms`...) from original.
Any metric in the patch not in the original set → **REJECT**.

Pattern: `/\b\d+(\.\d+)?(%|x|×|ms|s\b|k\b|M\b|B\b|hrs?|...)\b/gi`

### Rule 3: Length Integrity
- Patched bullet must be **≤160%** of original length
- Patched bullet must be **≥50%** of original length
Violating either threshold indicates a full rewrite → **REJECT**.

### Rule 4: ATS Compliance (from Career-Ops _shared.md)
- No zero-width characters
- No non-ASCII characters outside extended Latin
- No markdown formatting (`**`, `__`, `[...]`)
- No first-person voice ("I built", "I led")

### Rule 5: Meaning Preservation
Extracts the first action verb from both original and patched.
If the opening verb changed → **REJECT** (core meaning anchor changed).

### Fallback Chain

```
LLM generates patch
       ↓
Validator checks rules 1-5
       ↓
Any rule fails?
  YES → return original bullet as-is
         + skip_reason = "Validation rejected: <reason>"
         + patched: false
  NO  → return patched bullet
         + keywords_added: [...]
         + patched: true
```

---

## Failure Cases & Handling

| Failure | Behaviour |
|---|---|
| LLM returns invalid JSON | `patchBulletWithLLM()` catches and returns original |
| LLM introduces new tech | `checkNoNewTechnology()` rejects → original returned |
| LLM invents a metric | `checkNoFabricatedMetrics()` rejects → original returned |
| LLM fully rewrites bullet | `checkLengthIntegrity()` rejects → original returned |
| LLM adds markdown | `checkAtsCompliance()` rejects → original returned |
| LLM changes opening verb | `checkMeaningPreservation()` rejects → original returned |
| No injectable keywords for bullet | Skip entirely (`hasPatchOpportunity: false`) |
| Bullet is out-of-domain for all JD keywords | `irrelevant[]` only → skipped |
| GEMINI_API_KEY not set | All bullets returned unchanged with `skip_reason` |
| LLM timeout / network error | Caught in `patchBulletWithLLM()` → original returned |

---

## Example

**Input:**
```json
{
  "resume": {
    "experience": [
      {
        "role": "ML Engineer",
        "company": "Acme AI",
        "bullets": [
          "Built retrieval pipeline for document QA using LLM workflows and vector storage",
          "Deployed model serving infrastructure on GCP with monitoring dashboards"
        ]
      }
    ]
  },
  "job": {
    "skills_required": ["RAG", "LangChain", "Python"],
    "keywords": ["MLOps", "embeddings", "observability"]
  }
}
```

**Output:**
```json
{
  "patched_bullets": [
    {
      "original": "Built retrieval pipeline for document QA using LLM workflows and vector storage",
      "updated": "Built RAG pipeline for document QA using LLM orchestration workflows and vector embeddings",
      "keywords_added": ["RAG", "embeddings"],
      "patched": true
    },
    {
      "original": "Deployed model serving infrastructure on GCP with monitoring dashboards",
      "updated": "Deployed model serving infrastructure on GCP with MLOps observability and monitoring dashboards",
      "keywords_added": ["MLOps", "observability"],
      "patched": true
    }
  ],
  "stats": {
    "total": 2,
    "patched": 2,
    "skipped": 0,
    "rejected": 0
  }
}
```

---

## ATS Rules Applied (from Career-Ops pdf.md)

- Action verb first on every bullet
- No markdown or special formatting
- ASCII-safe output (normalization pre-validated)
- Keywords distributed naturally — not stacked at end
- No duplicate keyword injection (present list prevents this)
- Max 5 keywords injected per bullet (cap in service layer)
