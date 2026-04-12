# Frontend Job Detail View

## Component Structure

This facet introduces a single-job detail experience with focused, readable sections.

- apps/desktop/src/renderer/pages/JobDetail.tsx
  - Page for one job id.
  - Composes header, intelligence, resume diff, answers, timeline, and logs.
  - Manages section tabs: Overview, Resume, Answers, Logs.

- apps/desktop/src/renderer/utils/dashboard-routes.ts
  - Lightweight route parsing for dashboard paths.
  - Supports route format /dashboard/job/:jobId.
  - Provides navigation helpers for detail and list views.

- apps/desktop/src/renderer/pages/Dashboard.tsx
  - Switches main content based on parsed route.
  - Renders list view or detail view without dashboard redesign.

- apps/desktop/src/renderer/components/JobCard.tsx
  - View Details now navigates to /dashboard/job/:jobId by default.

## Data Flow

Primary lifecycle stream:

- useQueueJob(jobId)
  - status
  - progress
  - steps
  - logs
  - errors
  - cancel and refetch actions

Supplemental detail stream:

- getJobDetails(jobId) alias via getJobAnalysisDetails(jobId)
  - Loads optional job-level analysis summary/details payload.

Derived UI models:

- Intelligence fields from queue result payload and analysis payload.
- Resume diff lines normalized from known resume-change keys.
- Generated answers normalized from answer payload keys.
- Timeline rows mapped from step payload and log stream.

## Section Breakdown

Header:

- Back button
- Job title and company
- Status badge
- Progress bar
- Cancel button
- Failure banner with retry status fetch action

Overview tab:

- Job Intelligence
  - score
  - decision (APPLY, SKIP, RISKY)
  - matched skills
  - missing skills
  - risk flags
- Execution Timeline
  - analyze, patch, generate, apply
  - status per step
  - timestamp
  - first relevant log line

Resume tab:

- Side-by-side diff cards
  - original bullet
  - updated bullet
  - injected keywords badges

Answers tab:

- summary
- why_role
- strengths
- experience

Logs tab:

- Collapsible raw log viewer
- Scrollable container
- Monospace readable preformatted entries

## UI Decisions

- Preserve dark-compatible style system from existing UI primitives.
- Keep hierarchy clear using card sections and restrained emphasis.
- Highlight key data first: status, progress, score, decision.
- Use tabs to reduce clutter and keep focus.
- Keep timeline compact with readable step summaries.

## Hook Usage

- useQueueJob(jobId) drives all live execution state and actions.
- getJobDetails(jobId) augments contextual intelligence where available.
- No direct network calls from presentational components.

## Routing

Implemented dashboard detail route support:

- /dashboard/job/:jobId

Navigation behavior:

- JobCard View Details pushes detail route.
- Dashboard route parser renders JobDetail for detail paths.
- Back action returns to /dashboard list route.

## Future Improvements

- Strongly typed backend contract for resume diff and generated answers to remove heuristic extraction.
- Dedicated retry endpoint action for failed jobs.
- Rich timeline event grouping with per-step duration.
- Inline copy and export actions for generated answers and logs.
- URL query support for active tab selection and deep linking.
