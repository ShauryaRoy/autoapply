import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { OrchestratorService } from "../services/orchestratorService.js";
import type { ApplicationStep } from "@autoapply/shared";
import { emitApplicationUpdate } from "../realtime/io.js";

const WorkerEventSchema = z.object({
  applicationId: z.string().min(1),
  step: z.string().min(1),
  message: z.string().min(1),
  payloadJson: z.record(z.any()).optional()
});

const WorkerStepSchema = z.object({
  applicationId: z.string().min(1),
  currentStep: z.string().min(1),
  status: z.string().optional(),
  checkpointJson: z.record(z.any()).optional()
});

const AdvanceSchema = z.object({
  applicationId: z.string().min(1),
  nextStep: z.string().min(1)
});

const DlqSchema = z.object({
  queueName: z.string().min(1),
  originalJobId: z.string().min(1),
  applicationId: z.string().optional(),
  userId: z.string().optional(),
  step: z.string().optional(),
  reason: z.string().min(1),
  payloadJson: z.record(z.any())
});

function guardWorkerToken(req: Request, res: Response): boolean {
  const token = req.headers["x-worker-token"] as string | undefined;
  if (!token || token !== process.env.WORKER_TOKEN) {
    res.status(401).json({ message: "Invalid worker token" });
    return false;
  }
  return true;
}

export function createInternalWorkerRouter(): Router {
  const router = Router();
  const orchestrator = new OrchestratorService();

  router.post("/event", async (req: Request, res: Response, next: NextFunction) => {
    if (!guardWorkerToken(req, res)) return;

    try {
      const input = WorkerEventSchema.parse(req.body);
      await prisma.applicationEvent.create({
        data: {
          applicationRunId: input.applicationId,
          step: input.step,
          message: input.message,
          payloadJson: input.payloadJson ?? {}
        }
      });
      emitApplicationUpdate(input.applicationId, "event", {
        step: input.step,
        message: input.message
      });
      res.status(201).json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  router.post("/step", async (req: Request, res: Response, next: NextFunction) => {
    if (!guardWorkerToken(req, res)) return;

    try {
      const input = WorkerStepSchema.parse(req.body);
      const updateData: Record<string, unknown> = {
        currentStep: input.currentStep
      };

      if (input.status) {
        updateData.status = input.status;
      }

      if (input.checkpointJson) {
        updateData.checkpointJson = input.checkpointJson;
      }

      await prisma.applicationRun.update({
        where: { id: input.applicationId },
        data: updateData as never
      });
      emitApplicationUpdate(input.applicationId, "step", {
        step: input.currentStep,
        status: input.status ?? "running"
      });
      res.status(200).json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  router.post("/advance", async (req: Request, res: Response, next: NextFunction) => {
    if (!guardWorkerToken(req, res)) return;

    try {
      const input = AdvanceSchema.parse(req.body);
      await orchestrator.advance(input.applicationId, input.nextStep as ApplicationStep);
      res.status(200).json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  router.post("/dlq", async (req: Request, res: Response, next: NextFunction) => {
    if (!guardWorkerToken(req, res)) return;

    try {
      const input = DlqSchema.parse(req.body);
      await prisma.deadLetterJob.create({
        data: {
          queueName: input.queueName,
          originalJobId: input.originalJobId,
          applicationId: input.applicationId,
          userId: input.userId,
          step: input.step,
          reason: input.reason,
          payloadJson: input.payloadJson as never,
          status: "pending"
        }
      });
      res.status(201).json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
