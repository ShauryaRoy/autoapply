import { Queue } from "bullmq";
import { env } from "../config/env.js"; // Ensure redis connection is exported or pass url
import IORedis from "ioredis";
const Redis = (IORedis as any).default || IORedis;

// Create a shared Redis connection
export const connection = new Redis(env.redisUrl || "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
});

const defaultBullOpts = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 2000
  },
  removeOnComplete: true,
  removeOnFail: false
};

export const applicationQueue = new Queue("applicationQueue", { 
  connection,
  defaultJobOptions: defaultBullOpts
});

export const automationQueue = new Queue("automationQueue", {
  connection,
  defaultJobOptions: defaultBullOpts
});

export const dlqQueue = new Queue("applicationDlq", {
  connection
});

export interface AppQueuePayload {
  job_id: string;
  user_id?: string;
  job_url: string;
  user_profile: Record<string, any>;
  resume: Record<string, any>;
  resume_path?: string;
  status?: any;
}

import crypto from "node:crypto";

export async function addApplicationJob(payload: AppQueuePayload) {
  // Idempotency: hash user + job url
  const jobHash = crypto.createHash("sha256").update(payload.job_url + "_" + (payload.user_id || payload.job_id)).digest("hex");
  
  return await applicationQueue.add(`apply-${payload.job_id}`, payload, {
    jobId: jobHash,
    // Add base priority defaulting to 50
    priority: 50
  });
}

// Add specifically to automation queue
export async function addAutomationJob(payload: AppQueuePayload, score: number) {
  // BullMQ priority: 1 is highest. Score is 0-100.
  const bullPriority = Math.max(1, 100 - Math.round(score || 50));
  
  return await automationQueue.add(`automate-${payload.job_id}`, payload, {
    jobId: `auto-${payload.job_id}`,
    priority: bullPriority
  });
}
