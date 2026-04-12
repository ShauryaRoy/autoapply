# Frontend Onboarding Flow

## Onboarding Flow

The onboarding experience is a 3-step, outcome-driven flow:

- New User
- Resume Upload
- Preferences
- First Job Apply

Target outcome:

- first queued application with minimal friction
- immediate redirect to dashboard with success feedback

## Step Breakdown

Step 1: Resume Upload

- Component: apps/desktop/src/renderer/pages/onboarding/StepResumeUpload.tsx
- Supports drag-and-drop and file picker
- Accepts PDF and DOCX only
- Shows file preview (name and size)
- Shows upload progress indicator
- Blocking requirement: user cannot continue without uploaded resume text

Step 2: Preferences

- Component: apps/desktop/src/renderer/pages/onboarding/StepPreferences.tsx
- Collects:
  - preferred roles
  - preferred locations (remote, hybrid, onsite)
  - experience level
  - salary expectation (optional)
- Uses lightweight chips/buttons and simple inputs
- Preserves entered values when navigating back

Step 3: First Apply

- Component: apps/desktop/src/renderer/pages/onboarding/StepFirstApply.tsx
- Input: job URL or description
- Analyze Job flow:
  - calls analyzeJob(...)
  - shows score, decision, matched skills
  - shows preview of resume changes and generated answers
- Actions:
  - Apply: sends to queue
  - Skip: returns to previous step

## State Management

- Hook: apps/desktop/src/renderer/hooks/useOnboardingStore.ts

Store tracks:

- current step
- resume upload state (file, progress, parsed text, errors)
- preferences
- job input
- analysis result
- applying/analyzing/loading states

Navigation behavior:

- Next and Back controls
- required-step gating for resume upload and essential preferences
- backward navigation keeps previously entered values

## API Usage

Used existing frontend API layer without backend changes:

- uploadProfileResume(...) from existing renderer API module for resume upload
- analyzeJob(...) from modular api/job.ts for fit analysis
- addJobToQueue(...) from modular api/queue.ts for first application enqueue

Completion behavior:

- on successful first apply, store writes one-time success message to localStorage
- redirects to /dashboard
- dashboard reads and displays: Your first application is in progress 🚀

## UX Decisions

- concise copy and one clear CTA per step
- progress indicator at top (Step 1, Step 2, Step 3)
- low-friction forms and visual previews
- no heavy setup ceremony before first apply

Design goals met:

- fast
- clear
- minimal friction
- outcome-driven

## Edge Cases

Resume upload failure:

- displays actionable upload error
- keeps user on Step 1 until successful upload

Unsupported file type:

- immediate validation feedback for non-PDF/DOCX files

Analyze failure:

- step-level error shown in Step 3
- user can retry analysis without losing input

Empty job input:

- analysis blocked with simple instruction message

Apply failure:

- queue submission errors shown in Step 3
- user can retry apply action

Back navigation:

- preferences and analysis context preserved during step navigation
