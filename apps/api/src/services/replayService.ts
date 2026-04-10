import { prisma } from "../db/prisma.js";
import { scraperQueue, aiQueue, automationQueue } from "../queues/queue.js";

export async function replayDeadLetterJob(deadLetterId: string): Promise<void> {
  const dlq = await prisma.deadLetterJob.findUniqueOrThrow({ where: { id: deadLetterId } });
  const payload = dlq.payloadJson as Record<string, unknown>;

  if (dlq.queueName === "job-scraper") {
    await scraperQueue.add(`replay:scrape:${dlq.originalJobId}`, payload);
  } else if (dlq.queueName === "ai-processor") {
    await aiQueue.add(`replay:ai:${dlq.originalJobId}`, payload);
  } else {
    await automationQueue.add(`replay:automation:${dlq.originalJobId}`, payload);
  }

  await prisma.deadLetterJob.update({
    where: { id: deadLetterId },
    data: {
      status: "replayed",
      retryCount: { increment: 1 }
    }
  });
}
