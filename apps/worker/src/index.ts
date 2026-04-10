import dotenv from "dotenv";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScraper } from "./workers/scraperWorker.js";
import { runAi } from "./workers/aiWorker.js";
import { runAutomation } from "./workers/automationWorker.js";
import { writeDeadLetter } from "./lib/dlqWriter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null
});

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);

const scraperWorker = new Worker("job-scraper", runScraper, { connection, concurrency });
const aiWorker = new Worker("ai-processor", runAi, { connection, concurrency });
const automationWorker = new Worker("browser-automation", runAutomation, { connection, concurrency: 1 });

scraperWorker.on("completed", (job) => {
  console.log(`✅ [scraper] completed: ${job?.name}`);
});
scraperWorker.on("failed", async (job, error) => {
  console.error(`❌ [scraper] FAILED: ${job?.name} — ${error.message}`);
  if (!job) return;
  await writeDeadLetter({
    queueName: "job-scraper",
    originalJobId: job.id ?? "unknown",
    applicationId: job.data.applicationId,
    userId: job.data.userId,
    step: job.data.step,
    reason: error.message,
    payload: job.data
  });
});

aiWorker.on("completed", (job) => {
  console.log(`✅ [ai] completed: ${job?.name}`);
});
aiWorker.on("failed", async (job, error) => {
  console.error(`❌ [ai] FAILED: ${job?.name} — ${error.message}`);
  if (!job) return;
  await writeDeadLetter({
    queueName: "ai-processor",
    originalJobId: job.id ?? "unknown",
    applicationId: job.data.applicationId,
    userId: job.data.userId,
    step: job.data.step,
    reason: error.message,
    payload: job.data
  });
});

automationWorker.on("completed", (job) => {
  console.log(`✅ [automation] completed: ${job?.name}`);
});
automationWorker.on("failed", async (job, error) => {
  console.error(`❌ [automation] FAILED: ${job?.name} — ${error.message}`);
  console.error(error.stack);
  if (!job) return;
  await writeDeadLetter({
    queueName: "browser-automation",
    originalJobId: job.id ?? "unknown",
    applicationId: job.data.applicationId,
    userId: job.data.userId,
    step: job.data.step,
    reason: error.message,
    payload: job.data
  });
});

console.log("🟢 Workers online — scraper, ai, automation ready");

