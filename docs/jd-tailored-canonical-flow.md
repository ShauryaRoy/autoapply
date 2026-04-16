# JD-Tailored Canonical Flow

## 1. Problem

Tailoring existed in the pipeline but was not enforced as the canonical resume source.

- resume optimization could fall back to untailored data
- UI preview logic still allowed non-canonical resume rendering paths
- canonical readiness did not guarantee JD alignment
- form/PDF flows could drift from the latest tailored canonical

## 2. Fix

Tailoring output now replaces canonical directly and is validated as JD-optimized before pipeline continuation.

- worker tailoring input changed to JD-aware contract:
  - originalResume
  - jobDescription
  - requiredSkills
  - preferredSkills
- tailoring now builds a full canonical object (summary, skills, experience, projects, activities)
- untailored fallback canonical creation in AI worker was removed
- canonical validation now includes JD alignment guard (`Canonical resume is not JD-optimized`)
- canonical-only preview behavior enforced in dashboard resume stage
- canonical text builder is now authoritative for resume upload source in form filler/PDF prep

## 3. New Pipeline

originalResume
-> AI tailoring (JD-aware)
-> ResumeCanonical (structured + validated)
-> UI preview + PDF + form fill

## 4. Validation

JD alignment is now enforced by explicit canonical checks.

- `isTailored(canonical, jd)` verifies skill overlap with JD context
- invalid/untailored canonical throws and blocks progression
- dashboard canonical readiness requires:
  - tailoring triggered
  - valid canonical structure
  - tailored alignment to JD keywords
- resume preview renders canonical-only; non-ready states show generation status
- upload/PDF source is built from `buildResumeCanonical(resumeCanonical)`

## 5. Files Modified

- apps/worker/src/automation/tailor/types.ts
  - new JD tailoring input contract
  - canonical schema expanded with projects/activities
- apps/worker/src/automation/tailor/resumeTailor.ts
  - JD-aware tailoring implementation
  - canonical builder/validator updates
  - tailored guard (`isTailored`) and strict canonical generation
- apps/worker/src/workers/aiWorker.ts
  - authoritative canonical replacement flow
  - removed untailored canonical fallback
  - added JD keyword debug logging payload
- apps/worker/src/automation/liveApply/liveApplyController.ts
  - updated tailoring call to new JD-driven input signature
- apps/worker/src/lib/intelligentFormFiller.ts
  - canonical builder output now used as resume upload/PDF source
- apps/desktop/src/renderer/features/dashboard/components/structured-resume-preview.tsx
  - canonical-only preview rendering
  - optimized badge, matched skills display, injected/JD keyword highlighting
- apps/desktop/src/renderer/features/dashboard/main-dashboard-screen.tsx
  - canonical readiness gated by JD-tailored validity
  - removed original/parsed resume preview priority and fallback messaging
- apps/desktop/src/renderer/utils/resumeParser.ts
  - removed legacy parsed-resume fallback path from active flow
