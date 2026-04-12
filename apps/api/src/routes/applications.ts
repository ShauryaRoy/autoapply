import { Router, type Request, type Response, type NextFunction } from "express";
import { CreateApplicationSchema, type ApplicationState } from "@autoapply/shared";
import { prisma } from "../db/prisma.js";
import { OrchestratorService } from "../services/orchestratorService.js";
import { JobParserService } from "../services/jobParserService.js";
import { getProfileByUserId } from "../services/profileService.js";

function toYear(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const match = value.match(/(?:19|20)\d{2}/);
    return match ? Number(match[0]) : null;
  }
  return null;
}

function buildWorkerMetadata(profile: Awaited<ReturnType<typeof getProfileByUserId>>, fallbackMetadata?: Record<string, unknown>): Record<string, unknown> {
  const skills = (profile.skills ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === "string" && !!name.trim());

  return {
    ...(fallbackMetadata ?? {}),
    profile: {
      personal: {
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        phone: profile.phone,
        location: profile.location
      },
      education: (profile.education ?? []).map((entry) => ({
        institution: entry.school || null,
        field_of_study: entry.major || null,
        degree: entry.degree || null,
        start_year: toYear(entry.startYear),
        end_year: toYear(entry.endYear)
      })),
      experience: (profile.experience ?? []).map((entry) => ({
        job_title: entry.title || null,
        company: entry.company || null,
        location: entry.location || null,
        description: entry.description || null,
        start_year: toYear(entry.startYear),
        end_year: entry.current ? null : toYear(entry.endYear),
        current: !!entry.current
      })),
      skills,
      links: {
        linkedin: profile.links?.linkedin || profile.linkedIn || null,
        portfolio: profile.links?.portfolio || profile.portfolio || null,
        github: profile.links?.github || null
      }
    },
    resumeText: profile.resumeText ?? "",
    answers: profile.answers ?? {}
  };
}

export function createApplicationRouter(): Router {
  const router = Router();
  const orchestrator = new OrchestratorService();
  const parser = new JobParserService();

  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = CreateApplicationSchema.parse(req.body);
      const user = req.user;
      if (!user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }
      const atsProvider = parser.detectAtsProvider(payload.jobUrl);
      const authoritativeProfile = await getProfileByUserId(user.id);
      const snapshotMetadata = buildWorkerMetadata(authoritativeProfile, payload.metadata);

      const run = await prisma.applicationRun.create({
        data: {
          userId: user.id,
          jobUrl: payload.jobUrl,
          targetRole: payload.targetRole,
          status: "queued",
          currentStep: "queued",
          atsProvider,
          retries: 0,
          maxRetries: 5,
          checkpointJson: {
            metadata: snapshotMetadata
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
          metadata: snapshotMetadata
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
