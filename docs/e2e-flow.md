# End-to-End Application Flow

## Happy Path

1. User enters job URL and target role in desktop app.
2. API validates input and creates `ApplicationRun` in `queued`.
3. Orchestrator moves state to `job_scraped` and enqueues scraper queue.
4. Scraper worker parses posting and records normalized JD event.
5. Orchestrator advances to AI steps: `job_analyzed` -> `resume_optimized` -> `answers_generated`.
6. Automation worker starts browser context with persisted session.
7. Adapter logs in (or requests human intervention if CAPTCHA).
8. Adapter fills form fields and uploads assets.
9. Adapter submits application and verifies confirmation signal.
10. Run marked `completed`; dashboard stores full event history.

## Failure Recovery Path

1. Any step failure emits error event and increments retry count.
2. BullMQ retries with exponential backoff.
3. On repeated failure threshold, run enters `failed` with last checkpoint.
4. User can trigger resume after editing profile/answers.
5. Orchestrator resumes from last valid `currentStep` and `checkpointJson`.

## Human-in-the-Loop Path

1. CAPTCHA or MFA is detected by adapter.
2. Run status set to `waiting_user_action`.
3. Desktop displays intervention prompt with live browser state.
4. User resolves challenge manually and clicks resume.
5. Worker continues from checkpointed step.
