# AutoApply V1 (Desktop-First, Production-Grade)

AutoApply is a desktop-first AI application system for end-to-end job applications with human-in-the-loop controls and reliable orchestration.

## Monorepo Structure

- `apps/desktop`: Electron desktop UI
- `apps/api`: Node.js + TypeScript backend API
- `apps/worker`: BullMQ workers (scraper, AI, automation)
- `packages/shared`: cross-service contracts and state machine
- `docs`: architecture and operational docs

## Quick Start

1. Install dependencies:

   `pnpm install`

2. Start infrastructure:

   `docker compose up -d`

3. Configure environment:

   Copy `.env.example` into service-specific `.env` files.

4. Create Prisma client and migrate:

   - `pnpm db:generate`
   - `pnpm db:migrate`

5. Start services:

   - API: `pnpm --filter @autoapply/api dev`
   - Worker: `pnpm --filter @autoapply/worker dev`
   - Desktop: `pnpm --filter @autoapply/desktop dev`

## Production Controls Included

- JWT auth and protected application endpoints.
- Encrypted integration credential storage (AES-256-GCM).
- OpenTelemetry bootstrap for traces.
- Worker-authenticated internal API channel (`x-worker-token`).
- Dead-letter queue persistence + replay endpoint.
- ATS adapter SDK with field-map packs and test harness.

## End-to-End Flow

1. User pastes a job URL in desktop app.
2. API creates an `ApplicationRun` and starts orchestration.
3. Scraper worker parses job requirements.
4. AI worker optimizes resume and generates answer set.
5. Automation worker opens ATS in persistent browser context and fills/submits form.
6. Events stream to desktop with pause/resume controls.
7. Dashboard retains status/history for completed, failed, and paused runs.

## Production Hardening Checklist

- Add tenant isolation.
- Add metrics (Prometheus) and dashboards.
- Add chaos/failure injection tests for each orchestration step.
- Add robust adapter test suites per ATS platform.

## Smoke Validation (API + Worker)

1. Start infrastructure and services.
2. Register or login:
   - `POST /api/auth/register`
   - `POST /api/auth/login`
3. Create application:
   - `POST /api/applications` with bearer token.
4. Check progression:
   - `GET /api/applications/:id`
5. Replay failures:
   - `GET /api/dlq`
   - `POST /api/dlq/:id/replay`
