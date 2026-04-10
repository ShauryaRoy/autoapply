# Scaling and Improvements Plan

## Near-Term (V1.1)

- Add per-step idempotency tokens to avoid duplicate submissions.
- Add dead-letter queues with admin replay UI.
- Add OpenTelemetry tracing across API, Redis queues, and workers.
- Add deterministic adapter contract tests against ATS fixtures.

## Mid-Term (V1.5)

- Horizontal worker autoscaling by queue depth and step latency.
- Separate worker pools by concern:
  - Scrape pool (high parallelism)
  - AI pool (GPU or high-memory tuned)
  - Browser pool (low parallelism, high CPU/RAM)
- Introduce job-level distributed locks in Redis for strict single-run semantics.
- Add run prioritization and fair scheduling per user tier.

## Long-Term (V2)

- Multi-region control plane with region-local worker clusters.
- Feature store for retrieval-augmented answer consistency.
- Adaptive anti-detection policy engine by ATS and tenant risk profile.
- Benchmarking pipeline for conversion rate, completion time, and manual intervention rate.

## Critical KPIs

- End-to-end completion rate
- Retry success rate
- Median time-to-submit
- CAPTCHA/MFA intervention ratio
- Resume match score lift before vs after AI optimization
