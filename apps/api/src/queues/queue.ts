import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

const connection = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null
});

export const scraperQueue = new Queue("job-scraper", { connection });
export const aiQueue = new Queue("ai-processor", { connection });
export const automationQueue = new Queue("browser-automation", { connection });
