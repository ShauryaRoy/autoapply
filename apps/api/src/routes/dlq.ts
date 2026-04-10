import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "../db/prisma.js";
import { replayDeadLetterJob } from "../services/replayService.js";

export function createDlqRouter(): Router {
  const router = Router();

  router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const jobs = await prisma.deadLetterJob.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
        take: 200
      });
      res.json(jobs);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/replay", async (req: Request, res: Response, next: NextFunction) => {
    try {
      await replayDeadLetterJob(req.params.id);
      res.status(202).json({ status: "replayed" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
