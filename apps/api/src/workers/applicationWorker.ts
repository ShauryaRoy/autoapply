import { Worker, type Job } from "bullmq";
import { applicationQueue, automationQueue, dlqQueue, connection, type AppQueuePayload } from "../queue/applicationQueue.js";
import { processApplicationJob, processAutomationJob } from "../services/orchestrator.js";

// Keep track of job progress and status in worker memory / redis for status endpoint
export const applicationWorker = new Worker<AppQueuePayload>(
  "applicationQueue",
  async (job: Job<AppQueuePayload>) => {
    console.log(`[Worker] Started processing job ${job.id} for job_id: ${job.data.job_id}`);
    
    // Process application job
    const result = await processApplicationJob(job);
    
    if (result.status === "FAILED") {
      throw new Error("Application pipeline failed"); // Tripping error triggers BullMQ retries
    }

    return result;
  },
  { 
    connection,
    concurrency: 5 // applicationQueue → concurrency: 3–5
  }
);

export const automationWorker = new Worker<AppQueuePayload>(
  "automationQueue",
  async (job: Job<AppQueuePayload>) => {
    console.log(`[Worker] Started automation job ${job.id} for job_id: ${job.data.job_id}`);
    const result = await processAutomationJob(job);
    if (result.status === "FAILED") {
       throw new Error("Automation execution failed");
    }
    return result;
  },
  {
    connection,
    concurrency: 1 // Playwright is heavy
  }
);

// Register DLQ logic
const handleFailure = async (job: Job | undefined, err: Error, queueName: string) => {
  if (!job) return;
  console.log(`[${queueName}] Job ${job.id} failed: ${err.message}`);
  // If retries are completely exhausted, BullMQ marks it as failed. 
  // Wait to see if it's the final attempt
  if (job.attemptsMade >= (job.opts.attempts || 3)) {
    console.log(`[DLQ] Moving job ${job.id} to Dead Letter Queue...`);
    await dlqQueue.add(`dlq-${job.id}`, {
      originalJobId: job.id,
      failedQueue: queueName,
      reason: err.message,
      payload: job.data
    });
  }
};

applicationWorker.on("failed", (j, err) => handleFailure(j, err, "applicationQueue"));
automationWorker.on("failed", (j, err) => handleFailure(j, err, "automationQueue"));

applicationWorker.on("completed", (job) => console.log(`[Worker] App Job ${job.id} completed.`));
automationWorker.on("completed", (job) => console.log(`[Worker] Auto Job ${job.id} completed.`));
