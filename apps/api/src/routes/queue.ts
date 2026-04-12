import { Router, type Request, type Response } from "express";
import { addApplicationJob, applicationQueue } from "../queue/applicationQueue.js";
import { getQueueJobState, updateQueueJobState } from "../db/queueDb.js";
import { prisma } from "../db/prisma.js";
import { scanInternetJobs } from "../services/internetJobsService.js";
import { z } from "zod";

const router = Router();

const QueueJobSchema = z.object({
  job_id: z.string(),
  job_url: z.string(),
  user_profile: z.record(z.any()),
  resume: z.record(z.any()),
  resume_path: z.string().optional()
});

router.post("/add", async (req: Request, res: Response) => {
  try {
    const queueSize = await applicationQueue.getWaitingCount();
    if (queueSize > 50) {
      res.status(503).json({ error: "System busy, try later" });
      return;
    }

    const data = QueueJobSchema.parse(req.body);
    const job = await addApplicationJob(data);
    res.status(202).json({
      job_id: job.id,
      bullmq_id: job.id,
      status: "QUEUED"
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/status/:job_id", async (req: Request, res: Response) => {
  try {
    const reqJobId = req.params.job_id;
    // Check our persisted redis DB layer first
    const dbState = await getQueueJobState(reqJobId);
    
    // We can also poll BullMQ for overall progress if it's active
    const job = await applicationQueue.getJob(reqJobId).catch(() => null);
    const progress = job ? job.progress : (dbState?.status === "COMPLETED" ? 100 : 0);
    
    if (!dbState) {
       res.status(404).json({ error: "Job not found in tracking layer" });
       return;
    }

    // Convert string logs back to JSON structures 
    const logs = (dbState.result?.logs || []).map((l: string) => {
      try { return JSON.parse(l); } catch { return l; }
    });

    const completedSteps = Object.values(dbState.steps).filter(Boolean).length;
    // We have 4 total logical steps
    const progressVal = typeof progress === "number" ? progress : (typeof progress === "string" ? parseInt(progress, 10) : 0);
    const dynamicProgress = Math.max(progressVal, Math.round((completedSteps / 4) * 100));

    res.json({
      status: dbState.status,
      progress: dynamicProgress,
      steps: dbState.steps,
      logs: logs,
      errors: dbState.errors || [],
      result: dbState.result
    });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/cancel/:job_id", async (req: Request, res: Response) => {
  try {
    const reqJobId = req.params.job_id;
    const dbState = await getQueueJobState(reqJobId);
    
    if (dbState) {
      dbState.status = "CANCELLED";
      await updateQueueJobState(dbState);
    }
    
    // Look up jobs and attempt to remove it if waiting, or kill active workers
    const jobs = await applicationQueue.getJobs(["waiting", "active", "delayed"]);
    const pendingJob = jobs.find(j => j.data?.job_id === reqJobId);
    if (pendingJob) {
      await pendingJob.remove();
    }
    res.json({ status: "CANCELLED" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/metrics", async (req: Request, res: Response) => {
  try {
    const totalJobs = await prisma.queueJob.count();
    const completedJobs = await prisma.queueJob.count({ where: { status: "COMPLETED" } });
    const failedJobs = await prisma.queueJob.findMany({ where: { status: { in: ["FAILED", "PARTIAL_SUCCESS"] } } });
    
    const successRate = totalJobs > 0 ? (completedJobs / totalJobs) * 100 : 0;
    
    let timeTotal = 0;
    let timeCount = 0;
    const failureReasons: Record<string, number> = {};

    const allJobs = await prisma.queueJob.findMany({ select: { result: true } });
    for (const job of allJobs) {
      const resData = job.result as any;
      if (resData?.metrics?.steps) {
        Object.values(resData.metrics.steps).forEach((time: any) => {
          timeTotal += (time as number);
          timeCount++;
        });
      }
    }
    
    failedJobs.forEach(job => {
      const errs = job.errors as string[];
      if (Array.isArray(errs)) {
        errs.forEach(e => {
           // Capture leading snippet of error or standard code naturally
           const shortName = e.split(":")[0]?.substring(0, 50) || "Unknown"; 
           failureReasons[shortName] = (failureReasons[shortName] || 0) + 1;
        });
      }
    });

    res.json({
      total_jobs: totalJobs,
      success_rate: `${successRate.toFixed(2)}%`,
      avg_execution_time_ms: timeCount > 0 ? Math.round(timeTotal / timeCount) : 0,
      failure_reasons: failureReasons
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/internet-jobs", async (req: Request, res: Response) => {
  try {
    const query = typeof req.query.query === "string" ? req.query.query : undefined;
    const refresh = req.query.refresh === "1";
    const limitRaw = Number(req.query.limit ?? 120);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(250, Math.floor(limitRaw))) : 120;

    const result = await scanInternetJobs({
      query,
      forceRefresh: refresh,
      limit
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export function createQueueRouter(): Router {
  return router;
}
