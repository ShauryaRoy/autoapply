# Production V1 Architecture

## Product Surfaces

1. Desktop app (Electron): command center, manual intervention, live logs, resume preview/editing, credentials/settings.
2. API service (Node + TypeScript): user/auth profile APIs, application orchestration APIs, dashboard and history APIs.
3. Worker cluster: queue-driven scraper, AI processor, and browser automation workers.
4. Data layer: PostgreSQL for durable state + Redis for queues, locks, and transient runtime state.

## Reliability Design

- State machine orchestration with persisted checkpoints in `ApplicationRun.checkpointJson`.
- Every step emits an `ApplicationEvent` row and can be replayed in UI.
- BullMQ retries with exponential backoff per queue.
- Idempotent job handlers keyed by `applicationId + step`.
- Pause/Resume is explicit and durable: status persisted to DB and re-enqueued from current step.
- Browser session persistence with Playwright persistent contexts per user.
- Worker-to-API authenticated callback channel for event logging, step advancement, and DLQ writes.

## Key Services

- Scraper worker:
  - Parses job post and normalized requirement blocks.
  - Detects ATS provider and dynamic schema hints.
- AI worker:
  - Keyword extraction and requirement ranking.
  - Resume + project selection.
  - Consistent answer generation for ATS forms.
- Automation worker:
  - Uses provider adapters (Workday, Greenhouse, etc.).
  - Humanized timing/scroll/typing.
  - CAPTCHA handoff to user and continuation.

## Real-Time Streaming

- API emits run events over Socket.IO channels (`application:{id}`).
- Desktop subscribes and streams timeline + progress.

## Security and Compliance

- Encrypt profile secrets and third-party credentials at rest.
- JWT auth for user-facing APIs and separate worker token for internal orchestration APIs.
- Avoid storing raw passwords if SSO or OAuth options exist.
- Structured audit trail for every automated action.
- PII minimization in logs (masking, selective payload capture).

## Dead Letter and Replay

- Workers persist failed jobs to `DeadLetterJob` via internal API.
- Replay endpoint re-enqueues failed payloads back into original queues.
- Operators can triage failed runs and trigger replay from dashboard/API.
