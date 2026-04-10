import type { Job } from "bullmq";
import { workerAdvanceStep, workerLogEvent } from "../lib/apiClient.js";

export async function runScraper(job: Job): Promise<void> {
  const { applicationId, targetRole, jobUrl } = job.data as { applicationId: string; targetRole?: string; jobUrl?: string };

  await workerLogEvent({
    applicationId,
    step: "job_scraped",
    message: "Job description parsed and normalized",
    payloadJson: {
      title: targetRole ?? "unknown-role",
      source: jobUrl ?? "unknown-url"
    }
  });

  await workerAdvanceStep({ applicationId, nextStep: "job_analyzed" });
}
