# Frontend Lifecycle Hooks

## Hook Architecture

This facet adds a pure renderer hook layer that depends on the typed API module and keeps UI components API-agnostic:

- `apps/desktop/src/renderer/hooks/useQueueJob.ts`
  - Owns job lifecycle state for a single `jobId`.
  - Polls queue status every 2 seconds.
  - Normalizes backend status values to frontend lifecycle values.
  - Exposes manual `refetch()` and `cancel()` methods.
  - Uses a lightweight in-memory cache keyed by `jobId`.

- `apps/desktop/src/renderer/hooks/useQueueMetrics.ts`
  - Fetches queue-wide metrics via one reusable hook.
  - Exposes flattened metric fields + `refetch()`.

No dashboard page or widget logic is included in this facet.

## Polling Logic

`useQueueJob` polling behavior:

- Poll interval: `2000ms`.
- Endpoint call: `GET /api/queue/status/:job_id` through `getJobStatus(jobId)`.
- Starts polling on mount (or cache miss) and refreshes continuously while lifecycle is non-terminal.
- Keeps `isPolling` true while status is active.

## Lifecycle Flow

Backend statuses are normalized to frontend lifecycle status:

- `QUEUED` -> `PENDING`
- `PAUSED` -> `RUNNING` (treated as non-terminal execution phase)
- `COMPLETED` -> `SUCCESS`
- `PENDING` -> `PENDING`
- `RUNNING` -> `RUNNING`
- `FAILED` -> `FAILED`
- `PARTIAL_SUCCESS` -> `PARTIAL_SUCCESS`
- `CANCELLED` -> `CANCELLED`

Additional normalization:

- Progress is clamped to `0..100`.
- Missing `steps/logs/errors` are normalized to safe defaults.

## Stop Conditions

Polling stops when normalized status is terminal:

- `SUCCESS`
- `FAILED`
- `PARTIAL_SUCCESS`
- `CANCELLED`

These map directly to `isTerminalJobStatus(...)` semantics.

## Error Handling

Both hooks capture and expose typed errors:

- `ApiError` (network, timeout, bad response, backend failure)
- fallback `Error` for unknown exception shapes

`useQueueJob` behavior on status fetch error:

- Sets `error`
- Stops polling (`isPolling = false`)
- Preserves previous data where possible

`useQueueMetrics` behavior on fetch error:

- Sets `error`
- Keeps fallback-safe values (`0`, `0%`, `{}`)

## Cancellation

`useQueueJob.cancel()` calls `POST /api/queue/cancel/:job_id` via `cancelJob(jobId)`.

On success:

- Status is set to `CANCELLED`
- Polling is disabled
- Cached state is updated

On failure:

- Error is exposed through `error`
- Existing state is preserved

## UI Consumption

Typical usage pattern:

```tsx
const {
  status,
  progress,
  steps,
  logs,
  errors,
  isLoading,
  isPolling,
  error,
  refetch,
  cancel
} = useQueueJob(jobId);

const {
  total_jobs,
  success_rate,
  avg_execution_time,
  failure_reasons,
  isLoading: metricsLoading,
  error: metricsError,
  refetch: refetchMetrics
} = useQueueMetrics();
```

UI should:

- Render from hook state only.
- Avoid direct `fetch` calls in components.
- Use `refetch()` for user-triggered refresh.
- Use `cancel()` to terminate an in-flight job.

## Edge Cases

Retry:

- Any transient failure can be retried via `refetch()`.
- Polling does not auto-restart after an error; this is intentional for explicit UI control.

Cancel race:

- If status updates arrive near cancellation, `cancel()` sets local lifecycle to `CANCELLED` and disables polling.

Partial success:

- `PARTIAL_SUCCESS` is treated as terminal and polling stops.

Cache behavior:

- In-memory cache improves UX when remounting the same `jobId` in a session.
- Cache scope is renderer-runtime only; it resets on full app reload.
