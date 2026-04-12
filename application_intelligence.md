# Application Intelligence Service

> **Date:** 2026-04-12
> **Endpoint:** `POST /api/application/generate`

---

## What Was Learned from Career-Ops

### Career-Ops Block E (Personalisation) & Block F (Interview/STAR Prep)

Career-Ops used deeply personalized narrative blocks, generated separately:
* **Block E** shaped "Why this role" through candidate-specific framing.
* **Block F** generated STAR stories mapped strictly to JD requirements.

**Key insights adapted:**
1. **No generic fluff:** Career-Ops punished "I am passionate" and empty filler. "Tell me exactly how you fit the required skills, don't just express enthusiasm."
2. **Resume grounding:** STAR stories (Block F) were only pulled from explicit elements on the CV. You couldn't invent a STAR story.
3. **Targeted vocabulary:** Use the company's language and the JD's exact keywords.

---

## Service Adaptation

Career-Ops generated dense markdown reports meant for manual reading. AutoApply needs **form-ready strings** that can be injected automatically into an ATS or application funnel via UI pipelines.

| Concept | Career-Ops | Application Intelligence (AutoApply) |
|---|---|---|
| Focus | Deep, 10-page analytical report | Pre-computed, short text strings (2-4 lines) for immediate use |
| Input | Full parsed JD + Full CV.md | Filtered job metadata + matched skills from Analysis layer + *Patched Bullets* |
| Output | Narrative paragraphs | Strictly validated JSON `{ summary, why_role, answers: { ... } }` |

**The Strategy:**
Compile the heavily distilled signals (matched/missing skills) from the **Job Intelligence Service** and the freshly-tailored achievements from the **Resume Patch Engine**. This forces the generation of highly condensed, grounded application responses.

---

## Architecture

```
POST /api/application/generate
       │
       ▼
routes/applicationGen.ts         ← Validates structure (job, analysis, patched_bullets)
       │
       ▼
services/applicationService.ts    ← Orchestrates context & LLM
       │
       ├── utils/contextBuilder.ts  ← Sifts 'patched_bullets' & resume for Top 5 highlights
       │                            ← Formats a strict 'Prompt Context'
       │
       ├── [Gemini LLM]             ← Forced to return strict JSON under tight constraints
       │
       └── utils/validator.ts       ← Validation rules
                 ├── checkNoGenericPhrases()
                 ├── checkJobKeywordsApp()
                 └── checkResumeGrounding()
```

---

## Prompt Design

The prompt heavily relies on constraints to ensure answers sound human. 

```
You are a strict, top-tier executive recruiter drafting form application answers...

RULES:
1. DO NOT use generic boilerplate ("I am passionate about", "highly motivated").
2. DO NOT hallucinate skills or experience.
3. BE CONCISE. 2-4 lines MAXIMUM per answer.
4. MUST sound like a human professional writing a quick, sharp response.
5. Reference the company domain and role requirements.
6. PROVE strengths using exact accomplishments in the RESUME HIGHLIGHTS.
7. Return ONLY valid JSON format matching schema exactly.

CONTEXT:
ROLE: {jobRole} at {jobCompany} ({jobDomain})
MATCHED SKILLS: {matchedSkills}
MISSING SKILLS (Do NOT claim these): {missingSkills}
RESUME HIGHLIGHTS (Use these as proof):
- {bullet_1}
- {bullet_2}
...
```

- **Missing Skills constraint:** An explicit directive to prevent the LLM from inventing capabilities for known gaps.
- **Resume Highlights constraint:** Replaces the need to feed the entire parsed resume to the LLM, tightly bounding its "world view" to pre-validated patched achievements.

---

## Validation Rules

Application answers must pass validation. If they fail, `applicationService.ts` will **automatically retry generation** (up to 2 times) with the same Context before falling back to throwing an error.

1. **No Generic Phrases:**
   Checks output against `GENERIC_AI_PHRASES` (e.g., "in conclusion", "moreover", "as an ai", "testament to", "i am passionate about").
   *Reason:* We want it to sound like the applicant typed it out fast but professionally, not like ChatGPT authored a blog post.

2. **Job Keyword Presence:**
   If an answer exceeds 15 words (meaning it's likely a substantial behavioral/experience response), it *must* inject at least one valid job keyword provided in the context.
   *Reason:* Career-Ops demanded strict vocabulary mapping.

3. **Schema Completion Check:**
   Validates the presence of `summary`, `why_role`, `why_company`, `strengths`, and `experience` as distinct strings.

---

## Failure Handling

| Failure Scenario | Resolution Protocol |
|---|---|
| LLM returns generic AI language | `validateApplicationAnswers` rejects → service retries generation (up to `maxRetries`). |
| LLM invents capabilities | Bounded context prevents this, but keyword checks will throw an error if the model drifts too far. Retries. |
| Malformed JSON | LLM wraps JSON in markdown fences; regex cleans before JSON.parse(), throwing & retrying on bad schema. |
| Repeated generation failures | Service yields exception: `Failed to generate valid application answers after X attempts.` The pipeline can fallback to manual entry. |

---

## Refactor Improvements (v2)

### Hybrid Generation Approach
We transitioned from full LLM generation to a **hybrid model**:
- `summary`, `why_role`, `why_company` and `custom` fields are still generated by the LLM for high-context natural language.
- `strengths` is now generated using a template fill mapping directly to `matchedSkills`.
- `experience` natively reuses the validated `patched_bullets` (no LLM required).
*Reasoning*: Full LLM generation is prone to creative drift. Hybrid generation maintains quality while severely lowering hallucination risk and speeding up the compute.

### Validation Upgrades
1. **Word Limit (`checkWordLimit`)**: Strict bounding of 80 words max per answer to cleanly fit ATS textareas and maintain conciseness.
2. **Structural Validation (`checkStructuredWhyRole`)**: `why_role` answers are forced to conform to a specific logical arc (JD problem → Candidate Experience → Impact). It uses heuristics matching experience and impact transition markers.
3. **Tone Consistency (`checkToneConsistency`)**: Hard bans emotional phrasing (e.g., "thrilled", "passionate", "dream job").

### Expanded Schema & Confidence
- Added support for `custom: Record<string, string>` letting the LLM flexibly answer dynamic form questions if detected.
- Added a `confidence` floating point attribute based on keyword coverage and grounding baseline availability. This enables down-stream UIs to flag low-confidence responses for mandatory human review.

### Caching
A simple SHA-256 caching layer acts upon `jobKeywords` and `top_bullets`. Since the backend runs identical jobs through the pipeline multiple times, this prevents redundant LLM billing and significantly cuts latency.
