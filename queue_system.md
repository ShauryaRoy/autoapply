# Queue + Orchestration System

> **Date:** 2026-04-12
> **Architecture:** BullMQ, IORedis, and Node.js

---

## Architecture Overview

The Orchestration Pipeline is modeled around processing heavy job-application tasks asynchronously. Rather than forcing the frontend HTTP request to wait 30+ seconds for AI generation and browser automation to complete, jobs are inserted into a BullMQ-backed queue. 

**Stack:**
- **BullMQ**: Primary job broker. Built natively for complex DAGs and standard queuing patterns.
- **IORedis**: Persistent connection manager passing payload data.
- **Orchestrator Service**: The programmatic glue orchestrating (`analyze`, `patch`, `generate`, `apply`).

---

## Job Lifecycle

A job traverses 4 distinct sequential states. Failures at any stage result in halting the flow and propagating the exception backward into BullMQ to fire retries.

```text
POST /api/queue/add
        ↓
   [ Queue: applicationQueue ]
        ↓
   [ Worker: applicationWorker ]
        ↓
  STEP 1: Job Intelligence (Extract Archetype, Keywords, Scores)
        ↓
  STEP 2: Resume Patch (Inject Contextual Keywords via LLM)
        ↓
  STEP 3: Application Intelligence (Generate targeted answers)
        ↓
  STEP 4: Automation Engine (Headless Browser Auto-Fill)
        ↓
  DONE.
```

Clients can aggressively poll `GET /api/queue/status/:job_id` to acquire the internal JSON tracker reflecting exactly which `STEP` is running or has failed.

---

## Retry Strategy

If the Worker's `processApplicationJob` rejects with an Error (for instance, Playwright crashes or an LLM returns a malformed response), the job falls backwards into BullMQ's default options:

- **Attempts**: 3 Total (1 Initial, 2 Retries)
- **Backoff Layer**: `Exponential` backoff kicking in after `{ delay: 2000 }` to avoid spamming the APIs.
- **Granular Retain**: During execution, the Orchestrator marks specific steps as `"FAILED"`. On the next cycle, the overarching task resolves organically though future enhancements can cache intermediary data (i.e. jumping straight to STEP 4 rather than regenerating STEP 1).

---

## Failure Handling

1. **Local Error Stamping**: The inner wrapper forces actively `RUNNING` steps to `"FAILED"` so status API calls reveal precisely where the crash boundary exists (`analyze, patch, generate, apply`).
2. **Explicit Bubbling**: Worker explicitly `throws` any unresolved pipeline error to ensure BullMQ moves the job to the Failed state.
3. **Tracking**: The Orchestrator retains `result.logs` and `result.errors` string buffers to debug explicitly what caused a failure without trawling local PM2/Node logs.

---

## Service Integrations

The Orchestrator reuses entirely pre-built modules:
- *Job Intelligence*: Integrates legacy logic port from Career-Ops natively.
- *LLM Resume*: Feeds the resulting skills mapping into `<patchResume>`.
- *Application Intelligence*: Formulates the final payload required recursively back into `<generateApplicationAnswers>`.
- *Playwright Automation*: Submits JSON into the Headless browser executor directly via `<runAutomation>`.

---

## Final Production Hardening

### 1. DB Integration (PostgreSQL Persistence)
Rather than rerunning long queries locally within BullMQ `job.data`, an explicit DB integration (`QueueJob` utilizing Prisma to Postgres) natively stores `job_id`, `user_id`, `job_url`, state progression, logs, and outputs avoiding entirely data volitility present in strictly Redis stacks. 

### 2. Progress Tracking
The APIs dynamically evaluate `/status/:job_id` dynamically fetching properties computing completion arrays directly bounded to integer ratios mapping native steps progression safely across UI fronts (`progress = (completed_steps / total_steps) * 100`).

### 3. Partial Success
If an unresolvable exception occurs natively at the browser layer—while leaving the AI generation logic fully resolved—the persistence engine explicitly falls back into `PARTIAL_SUCCESS`. This retains computationally expensive AI tokens letting users review or download custom cover letters rather than outright returning blind `FAILED` states.

### 4. Queue Linking
Once the `applicationQueue` executes logic mapping steps 1-3, it forwards into the `automationQueue` actively pushing backwards object representations `queue_link: { parent_job_id, automation_job_id }` inside the result bindings avoiding disjointed tracking layers across UI queries. 

### 5. Rate Limiting
Globally imported `p-limit` bounding parallel requests synchronously enforcing LLM bindings to `< 5` bounds explicitly safeguarding platform quotas while isolating heavy Chromium parallel scaling limits strictly into `< 2`.

### 6. Cancellation API
Endpoint exposed `/queue/cancel/:job_id`. Resolves job deletion queries directly wiping waiting arrays off Redis Bull instances instantaneously while natively propagating `status = CANCELLED` mapping against DB constraints avoiding stranded logic flows.

### 7. Metrics & Observability
Endpoint exposed `/queue/metrics`. Analyzes `QueueJob` tables aggregating internal timers bounding native `Promise.race` resolutions. Returns tracked `total_jobs`, ratio-mapped `success_rate`, bounded `avg_execution_time_ms`, and aggregates localized native stack-traces mapped heavily into `failure_reasons`.

### 8. Backpressure Protection
Tied to queue-wide execution bounds. On pushing newly requested configurations through `/add`, the orchestrator reads Redis array allocations strictly. Above 50 bounded limits throws native 503 limits preventing runaway execution queues gracefully.
