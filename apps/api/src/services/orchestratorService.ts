import { applyEvent, type ApplicationState, type ApplicationStep, type StepEvent } from "@autoapply/shared";
import { prisma } from "../db/prisma.js";
import { scraperQueue, aiQueue, automationQueue } from "../queues/queue.js";
import { emitApplicationUpdate } from "../realtime/io.js";

const stepToQueue: Partial<Record<ApplicationStep, "scraper" | "ai" | "automation">> = {
  job_scraped: "scraper",
  job_analyzed: "ai",
  resume_optimized: "ai",
  answers_generated: "ai",
  browser_started: "automation",
  logged_in: "automation",
  form_filled: "automation",
  submitted: "automation"
};

export class OrchestratorService {
  async start(state: ApplicationState): Promise<void> {
    const next = applyEvent(state, { type: "START" });
    await this.persistState(state.applicationId, next.step, next);
    await this.enqueueStep(state.applicationId, next.step, state.userId);
  }

  async advance(applicationId: string, next: ApplicationStep): Promise<void> {
    const run = await prisma.applicationRun.findUniqueOrThrow({ where: { id: applicationId } });
    const state: ApplicationState = {
      applicationId: run.id,
      userId: run.userId,
      step: run.currentStep as ApplicationStep,
      atsProvider: run.atsProvider as ApplicationState["atsProvider"],
      retries: run.retries,
      maxRetries: run.maxRetries,
      lastError: run.lastError ?? undefined,
      checkpoint: (run.checkpointJson as Record<string, unknown> | null) ?? undefined
    };

    const nextState = applyEvent(state, { type: "STEP_OK", next });
    await this.persistState(applicationId, nextState.step, nextState);
    await this.enqueueStep(applicationId, nextState.step, state.userId);
  }

  async fail(applicationId: string, error: string): Promise<void> {
    await prisma.applicationRun.update({
      where: { id: applicationId },
      data: {
        retries: { increment: 1 },
        lastError: error,
        status: "failed",
        currentStep: "failed"
      }
    });
    emitApplicationUpdate(applicationId, "status", { status: "failed", error });
  }

  async pause(applicationId: string): Promise<void> {
    await prisma.applicationRun.update({
      where: { id: applicationId },
      data: {
        status: "paused",
        currentStep: "paused"
      }
    });
    emitApplicationUpdate(applicationId, "status", { status: "paused" });
  }

  async resume(applicationId: string): Promise<void> {
    const run = await prisma.applicationRun.findUniqueOrThrow({ where: { id: applicationId } });
    await prisma.applicationRun.update({
      where: { id: applicationId },
      data: { status: "running" }
    });
    emitApplicationUpdate(applicationId, "status", { status: "running" });
    await this.enqueueStep(applicationId, run.currentStep as ApplicationStep, run.userId);
  }

  async logStep(event: StepEvent): Promise<void> {
    await prisma.applicationEvent.create({
      data: {
        applicationRunId: event.applicationId,
        step: event.step,
        message: event.message,
        payloadJson: (event.data ?? {}) as never
      }
    });
    emitApplicationUpdate(event.applicationId, "event", {
      step: event.step,
      message: event.message
    });
  }

  private async persistState(
    applicationId: string,
    step: ApplicationStep,
    state: ApplicationState
  ): Promise<void> {
    await prisma.applicationRun.update({
      where: { id: applicationId },
      data: {
        currentStep: step,
        status: step === "completed" ? "completed" : step === "failed" ? "failed" : "running",
        lastError: state.lastError ?? null,
        retries: state.retries,
        checkpointJson: (state.checkpoint ?? {}) as never
      }
    });
    emitApplicationUpdate(applicationId, "step", { step, status: step === "completed" ? "completed" : step === "failed" ? "failed" : "running" });
  }

  private async enqueueStep(applicationId: string, step: ApplicationStep, userId: string): Promise<void> {
    const targetQueue = stepToQueue[step];
    if (!targetQueue) {
      return;
    }

    const run = await prisma.applicationRun.findUniqueOrThrow({ where: { id: applicationId } });

    const checkpoint = (run.checkpointJson as Record<string, unknown> | null) ?? {};
    const payload = {
      applicationId,
      step,
      userId,
      jobUrl: run.jobUrl,
      targetRole: run.targetRole,
      metadata: checkpoint.metadata ?? {}
    };

    if (targetQueue === "scraper") {
      await scraperQueue.add(`scrape:${applicationId}:${step}`, payload, { attempts: 3, backoff: { type: "exponential", delay: 3000 } });
      return;
    }

    if (targetQueue === "ai") {
      await aiQueue.add(`ai:${applicationId}:${step}`, payload, { attempts: 3, backoff: { type: "exponential", delay: 3000 } });
      return;
    }

    await automationQueue.add(`automation:${applicationId}:${step}`, payload, { attempts: 3, backoff: { type: "exponential", delay: 5000 } });
  }
}
