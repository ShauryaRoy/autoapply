import type { Job } from "bullmq";
import { workerAdvanceStep, workerLogEvent, workerUpdateStep } from "../lib/apiClient.js";
import { GeminiService } from "../lib/ai/geminiService.js";

const gemini = new GeminiService();

export async function runAi(job: Job): Promise<void> {
  const { applicationId, step, targetRole, jobUrl, metadata } = job.data as {
    applicationId: string;
    step: string;
    targetRole?: string;
    jobUrl?: string;
    metadata?: Record<string, unknown>;
  };
  const resumeText = String(metadata?.resumeText ?? "");
  const customAnswers = (metadata?.answers as Record<string, string> | undefined) ?? {};
  const profile = (metadata?.profile as Record<string, string> | undefined) ?? {};

  if (step === "job_analyzed") {
    console.log(`\n🧠 [aiWorker] step=job_analyzed appId=${applicationId}`);
    const insights = await gemini.extractJobInsights({ targetRole, jobUrl });

    await workerLogEvent({
      applicationId,
      step: "job_analyzed",
      message: "Keywords extracted and skill gap scored",
      payloadJson: {
        keywords: insights.keywords,
        skillGaps: insights.skillGaps,
        relevanceScore: insights.relevanceScore
      }
    });

    await workerAdvanceStep({ applicationId, nextStep: "resume_optimized" });
    return;
  }

  if (step === "resume_optimized") {
    console.log(`\n🧠 [aiWorker] step=resume_optimized appId=${applicationId}`);
    const optimization = await gemini.optimizeResume({
      targetRole,
      resumeText,
      keywords: ["typescript", "playwright", "redis", "postgresql", ...(resumeText ? ["resume-context"] : [])]
    });

    await workerLogEvent({
      applicationId,
      step: "resume_optimized",
      message: "Resume tailored for role",
      payloadJson: {
        scoreBefore: optimization.scoreBefore,
        scoreAfter: optimization.scoreAfter,
        selectedProjects: optimization.selectedProjects,
        tailoredBullets: optimization.tailoredBullets
      }
    });

    await workerAdvanceStep({ applicationId, nextStep: "answers_generated" });
    return;
  }

  // step === "answers_generated"
  console.log(`\n🧠 [aiWorker] step=answers_generated appId=${applicationId}`);
  const generatedAnswers = await gemini.generateFormAnswers({
    targetRole,
    resumeText,
    profile,
    keywords: ["typescript", "playwright", "redis", "postgresql"]
  });

  // Merge: custom user answers override AI-generated ones
  const mergedAnswers = {
    ...generatedAnswers.answers,
    ...customAnswers
  };

  await workerLogEvent({
    applicationId,
    step: "answers_generated",
    message: "Form answers generated and consistency checked",
    payloadJson: {
      checks: generatedAnswers.checks,
      answers: mergedAnswers
    }
  });

  // ✅ CRITICAL: Write answers back into the checkpoint so the automation worker
  // receives them when it runs form_filled. Without this the browser step only
  // has the original user-supplied custom answers.
  await workerUpdateStep({
    applicationId,
    currentStep: "answers_generated",
    checkpointJson: {
      metadata: {
        profile,
        resumeText,
        answers: mergedAnswers
      }
    }
  });

  console.log(`   ✓ Checkpoint written with ${Object.keys(mergedAnswers).length} answers`);
  console.log(`   → Advancing to browser_started`);
  await workerAdvanceStep({ applicationId, nextStep: "browser_started" });
}
