# Frontend Dashboard UI

## Component Structure

This facet introduces a focused job list dashboard UI built on top of existing lifecycle hooks.

- apps/desktop/src/renderer/pages/Dashboard.tsx
  - Page-level layout and orchestration.
  - Renders metrics header and job list region.
  - Uses DashboardLayout to respect existing sidebar patterns.

- apps/desktop/src/renderer/components/JobList.tsx
  - List/empty/loading state manager for jobs.
  - Renders responsive card grid.
  - Displays friendly empty state with add-job CTA.

- apps/desktop/src/renderer/components/JobCard.tsx
  - Per-job visual card.
  - Uses useQueueJob(jobId) directly for isolated lifecycle state.
  - Exposes View details and Cancel job actions.

## Data Flow (Hooks to UI)

Dashboard page:

- useQueueMetrics() powers top metrics header cards.
- Receives jobs as input from parent orchestration layer.
- Passes each job to JobList.

Job list:

- Maps input jobs to JobCard components.
- Handles list-level loading skeletons and empty state.

Job card:

- Calls useQueueJob(jobId).
- Receives live state: status, progress, logs, errors, polling state.
- Triggers cancel() through hook action.

No component performs direct network calls.

## Status Mapping

UI status treatment follows product mapping:

- PENDING: gray
- RUNNING: blue
- SUCCESS: green
- FAILED: red
- PARTIAL_SUCCESS: yellow
- CANCELLED: muted

Mapping is reflected in both badge tone and progress bar color.

## UI States

Loading states:

- Metrics header shows skeleton values while metrics are loading.
- JobList can show card skeletons during job-collection loading.
- JobCard keeps graceful placeholders while per-job state hydrates.

Active states:

- Live progress bar with smooth transition animation.
- Polling hint text (Polling updates / Polling stopped).
- Error summary and action controls remain visible.

Empty state:

- Friendly no-jobs copy.
- Clear CTA button to add first job.

Error states:

- Metrics fetch error is surfaced in a non-blocking banner.
- Per-job hook errors are shown inside each card.

## Layout Decisions

- Existing DashboardLayout retained for visual consistency.
- Sidebar slot is preserved and provided externally.
- Left rail used for concise queue overview context.
- Main content emphasizes hierarchy:
  - title and intent
  - metrics header
  - job list grid

Responsive behavior:

- Single column on small screens.
- Multi-column card grid on medium and large breakpoints.

## Future Improvements

- Client-side sorting (status, recency, score).
- Basic filtering chips (running, failed, completed).
- Pagination or windowing for very large job volumes.
- Batch actions for cancel/retry where backend supports it.
- Dedicated job detail route and timeline view.
