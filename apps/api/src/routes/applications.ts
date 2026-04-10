import { Router, type Request, type Response, type NextFunction } from "express";
import { CreateApplicationSchema, type ApplicationState } from "@autoapply/shared";
import { prisma } from "../db/prisma.js";
import { OrchestratorService } from "../services/orchestratorService.js";
import { JobParserService } from "../services/jobParserService.js";
import type { AuthClaims } from "../auth/jwt.js";

export function createApplicationRouter(): Router {
  const router = Router();
  const orchestrator = new OrchestratorService();
  const parser = new JobParserService();

  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = CreateApplicationSchema.parse(req.body);
      const user = (req as Request & { user?: AuthClaims }).user;
      if (!user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }
      const atsProvider = parser.detectAtsProvider(payload.jobUrl);

      const run = await prisma.applicationRun.create({
        data: {
          userId: user.sub,
          jobUrl: payload.jobUrl,
          targetRole: payload.targetRole,
          status: "queued",
          currentStep: "queued",
          atsProvider,
          retries: 0,
          maxRetries: 5,
          checkpointJson: {
            metadata: payload.metadata ?? {}
          } as never
        }
      });

      const initial: ApplicationState = {
        applicationId: run.id,
        userId: run.userId,
        step: "queued",
        atsProvider,
        retries: 0,
        maxRetries: 5,
        checkpoint: {
          metadata: payload.metadata ?? {}
        }
      };

      await orchestrator.start(initial);

      res.status(201).json({ applicationId: run.id });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/pause", async (req: Request, res: Response, next: NextFunction) => {
    try {
      await orchestrator.pause(req.params.id);
      res.status(202).json({ status: "paused" });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/resume", async (req: Request, res: Response, next: NextFunction) => {
    try {
      await orchestrator.resume(req.params.id);
      res.status(202).json({ status: "resumed" });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const run = await prisma.applicationRun.findUnique({
        where: { id: req.params.id },
        include: { events: { orderBy: { createdAt: "asc" }, take: 200 } }
      });
      if (!run) {
        res.status(404).json({ message: "Application not found" });
        return;
      }
      res.json(run);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
