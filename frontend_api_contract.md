# Frontend API Contract

## Frontend API Architecture

The frontend API integration foundation is implemented as a dedicated renderer layer at `apps/desktop/src/renderer/api`.

- `client.ts`: shared HTTP client and centralized error handling (`ApiError` + typed error codes).
- `contracts.ts`: request/response interfaces for queue and job operations.
- `status.ts`: shared job status model and terminal-state helper.
- `queue.ts`: queue-focused endpoint wrappers.
- `job.ts`: job-analysis endpoint wrappers.
- `application.ts`: application-run endpoint wrappers for existing orchestration workflows.
- `index.ts`: barrel export for a stable import surface.

Design goals met:
- Components can import typed API functions instead of calling `fetch` directly.
- Networking and UI concerns are separated.
- Data shapes are explicit and reusable.
- Layer is polling-ready because each operation is idempotent, typed, and independently callable.

## Endpoint List

Queue endpoints:
- `POST /api/queue/add`
- `GET /api/queue/status/:job_id`
- `POST /api/queue/cancel/:job_id`
- `GET /api/queue/metrics`

Job endpoints:
- `GET /api/job/:job_id` (forward-compatible helper)
- `POST /api/job/analyze`

Application endpoints (existing backend flow support):
- `POST /api/applications`
- `GET /api/applications/:id`
- `POST /api/applications/:id/pause`
- `POST /api/applications/:id/resume`

## Request/Response Shapes

### Add Job To Queue

Request (`QueueAddRequest`):
- `job_id: string`
- `job_url: string`
- `user_profile: Record<string, unknown>`
- `resume: Record<string, unknown>`
- `resume_path?: string`

Response (`QueueAddResponse`):
- `job_id: string`
- `bullmq_id: string`
- `status: "QUEUED"`

### Get Job Status

Response (`QueueStatusResponse`):
- `status: JobStatus | "PAUSED" | "COMPLETED" | "QUEUED"`
- `progress: number`
- `steps: QueueSteps`
- `logs: unknown[]`
- `errors: string[]`
- `result: Record<string, unknown>`

### Cancel Job

Response (`QueueCancelResponse`):
- `status: "CANCELLED"`

### Get Queue Metrics

Response (`QueueMetricsResponse`):
- `total_jobs: number`
- `success_rate: string`
- `avg_execution_time_ms: number`
- `failure_reasons: Record<string, number>`

### Get Job Analysis Details

Response (`JobAnalysisDetailsResponse`):
- `job_id: string`
- `status: JobStatus | "PAUSED" | "COMPLETED" | "QUEUED"`
- `summary?: string`
- `details?: Record<string, unknown>`

### Analyze Job (existing backend capability)

Request (`AnalyzeJobRequest`):
- `jobDescription: string`
- `companyName?: string`
- `jobTitle?: string`
- `profileText?: string`
- `profileSkills?: string[]`
- `ghostRiskHints?: { postingAgeDays?: number | null; hasApplyButton?: boolean; repostCount?: number }`
- `preferredRemotePolicies?: ("fully-remote" | "hybrid" | "onsite" | "geo-restricted" | "unknown")[]`

Response (`AnalyzeJobResponse`):
- `job: { title; company; remotePolicy; archetype; seniority; domain; tldr }`
- `analysis: { score; decision; apply_priority; matched_skills; missing_skills; risk_flags; match_score; score_breakdown }`
- `details: { roleSummary; requiredSkills; preferredSkills; keywords; cvMatch; ghostRisk }`

## Status Model

Defined in `status.ts`:
- `PENDING`
- `RUNNING`
- `SUCCESS`
- `FAILED`
- `PARTIAL_SUCCESS`
- `CANCELLED`

Plus helper:
- `isTerminalJobStatus(status)` to simplify future polling stop conditions.

## Error Handling Approach

Centralized in `client.ts` via `ApiError`:
- `NETWORK_ERROR`: fetch/network failures.
- `BAD_RESPONSE`: non-JSON payloads or malformed successful responses.
- `TIMEOUT`: request exceeded timeout (default 15s, override per request).
- `BACKEND_ERROR`: backend returned a known failure payload (`message` or `error`) and/or server failure status.

The API client:
- Applies `Authorization` bearer token from local storage (`autoapply_token`) automatically.
- Enforces timeout with `AbortController`.
- Parses backend message fields (`message` and `error`) for user-safe surfacing.

## What Changed In The Codebase

Added files:
- `apps/desktop/src/renderer/api/client.ts`
- `apps/desktop/src/renderer/api/contracts.ts`
- `apps/desktop/src/renderer/api/status.ts`
- `apps/desktop/src/renderer/api/queue.ts`
- `apps/desktop/src/renderer/api/job.ts`
- `apps/desktop/src/renderer/api/application.ts`
- `apps/desktop/src/renderer/api/index.ts`
- `frontend_api_contract.md`

No dashboard UI behavior was changed.
No components were updated to call backend directly.

## Next Facet To Build

Build a small frontend domain store/hooks layer that consumes this API foundation and prepares the dashboard for controlled polling and optimistic status transitions.

Suggested scope for next facet:
- Create `useQueueJob` and `useQueueMetrics` hooks.
- Add adapter mappers from raw API contracts to UI view models.
- Introduce a lightweight cache/polling coordinator (React Query or custom interval manager).
- Wire only one non-destructive dashboard widget to validate end-to-end flow.
