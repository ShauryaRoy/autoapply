import type { Job } from "bullmq";
import { workerAdvanceStep, workerLogEvent, workerUpdateStep } from "../lib/apiClient.js";
import { GeminiService } from "../lib/ai/geminiService.js";
import { analyzeJob } from "../automation/tailor/jobAnalyzer.js";
import { buildResumeCanonical, generatePDF, tailorResume, validateResumeCanonical } from "../automation/tailor/resumeTailor.js";
import { type ResumeCanonical } from "../automation/tailor/types.js";

const gemini = new GeminiService();
const AUTO_APPLY_THRESHOLD = Number(process.env.AUTO_APPLY_THRESHOLD ?? "70");

type ResumeDiff = {
  section: string;
  added?: string[];
  removed?: string[];
  reason?: string;
};

function buildStructuredDiff(originalResumeText: string, canonical: ResumeCanonical): ResumeDiff[] {
  return [
    {
      section: "summary",
      added: [canonical.summary],
      reason: "Aligned summary with job role."
    },
    {
      section: "skills",
      added: canonical.skills,
      reason: "Injected relevant skills."
    }
  ];
}

export async function runAi(job: Job): Promise<void> {
  const { applicationId, step, targetRole, jobUrl, metadata } = job.data as {
    applicationId: string;
    step: string;
    targetRole?: string;
    jobUrl?: string;
    metadata?: Record<string, unknown>;
  };
  
  const originalResume = String(metadata?.originalResume ?? metadata?.resumeText ?? "");
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

    await workerUpdateStep({
      applicationId,
      currentStep: "job_analyzed",
      checkpointJson: {
        metadata: {
          ...(metadata ?? {}),
          originalResume,
          jobInsights: insights
        }
      }
    });

    await workerAdvanceStep({ applicationId, nextStep: "resume_optimized" });
    return;
  }

  if (step === "resume_optimized") {
    console.log(`\n🧠 [aiWorker] step=resume_optimized appId=${applicationId}`);
    const optimization = await gemini.optimizeResume({
      targetRole,
      resumeText: originalResume,
      keywords: ["typescript", "playwright", "redis", "postgresql", ...(originalResume ? ["resume-context"] : [])]
    });

    const jobInsights = (metadata?.jobInsights as { keywords?: string[]; skillGaps?: string[]; relevanceScore?: number } | undefined) ?? {};
    const heuristicScore = Math.round(Math.max(0, Math.min(1, jobInsights.relevanceScore ?? optimization.scoreAfter)) * 100);
    
    let resumeCanonical: ResumeCanonical | null = null;
    let tailoringError: string | null = null;
    const shouldTailor = heuristicScore >= AUTO_APPLY_THRESHOLD;

    if (shouldTailor) {
      await workerLogEvent({
        applicationId,
        step: "resume_optimized",
        message: "Tailoring triggered",
        payloadJson: {
          heuristicScore,
          threshold: AUTO_APPLY_THRESHOLD
        }
      });

      try {
        const syntheticJd = [
          `Role: ${targetRole ?? "Unknown"}`,
          `Keywords: ${(jobInsights.keywords ?? []).join(", ")}`,
          `Skill gaps: ${(jobInsights.skillGaps ?? []).join(", ")}`,
        ].join("\n");

        const jobProfile = await analyzeJob({ jobDescription: syntheticJd });
        
        // tailorResume already generates ResumeCanonical and enforces limits
        resumeCanonical = await tailorResume({
          baseResume: originalResume,
          jobProfile
        });
        
        resumeCanonical.version = 1;
        resumeCanonical.generatedFor = targetRole ?? jobProfile.role;
        resumeCanonical.generatedAt = new Date().toISOString();

        validateResumeCanonical(resumeCanonical, [...jobProfile.skills, ...(jobInsights.keywords ?? [])]);
        
        // Verify canonical generation
        const computed = buildResumeCanonical(resumeCanonical);
        if (computed !== resumeCanonical.rawText) {
          throw new Error("Canonical mismatch — blocking PDF generation");
        }

        await workerLogEvent({
          applicationId,
          step: "resume_optimized",
          message: "Tailored resume generated",
          payloadJson: {
            diff: buildStructuredDiff(originalResume, resumeCanonical),
            resumeCanonical,
            originalResume,
            version: resumeCanonical.version,
            tailoringTriggered: shouldTailor,
            fallbackUsed: false,
            threshold: AUTO_APPLY_THRESHOLD,
            scoreBefore: Math.round(optimization.scoreBefore * 100),
            scoreAfter: heuristicScore
          }
        });
      } catch (error) {
        tailoringError = error instanceof Error ? error.message : String(error);
        await workerLogEvent({
          applicationId,
          step: "resume_optimized",
          message: "Tailoring failed, falling back to original resume",
          payloadJson: {
            error: tailoringError,
            tailoringError,
            resumeCanonical: null, // Will use un-tailored via frontend/worker defaults
            originalResume,
            version: 0,
            tailoringTriggered: true,
            fallbackUsed: true,
            threshold: AUTO_APPLY_THRESHOLD,
            scoreBefore: Math.round(optimization.scoreBefore * 100),
            scoreAfter: heuristicScore
          }
        });
      }
    }

    if (!shouldTailor || tailoringError) {
      // Create a default un-tailored canonical object from the original resume
      const rawLines = originalResume.split(/\r?\n/).filter(line => line.trim());
      resumeCanonical = {
        summary: rawLines.length > 0 ? rawLines[0] : "",
        skills: [],
        experience: [{ title: "Original Experience", bullets: rawLines.slice(1, 5) }],
        rawText: originalResume,
        keywordsInjected: [],
        version: 0,
        generatedFor: targetRole ?? "unknown",
        generatedAt: new Date().toISOString()
      };
    }

    // Add to resumeHistory
    const resumeHistory = (metadata?.resumeHistory as any[] ?? []);
    if (resumeCanonical) {
        resumeHistory.push({
            version: resumeCanonical.version ?? 0,
            canonical: resumeCanonical,
            jobId: applicationId,
            timestamp: new Date().toISOString()
        });
    }

    await workerUpdateStep({
      applicationId,
      currentStep: "resume_optimized",
      checkpointJson: {
        metadata: {
          ...(metadata ?? {}),
          originalResume,
          resumeCanonical,
          resumeHistory,
          resumeVersion: resumeCanonical?.version ?? 0,
          tailoringTriggered: shouldTailor,
          tailoringThreshold: AUTO_APPLY_THRESHOLD,
          tailoringError,
          fallbackUsed: Boolean(tailoringError)
        }
      }
    });

    await workerAdvanceStep({ applicationId, nextStep: "answers_generated" });
    return;
  }

  if (step === "answers_generated") {
    console.log(`\n🧠 [aiWorker] step=answers_generated appId=${applicationId}`);
    const generatedAnswers = await gemini.generateFormAnswers({
      targetRole,
      resumeText: originalResume,
      profile,
      keywords: ["typescript", "playwright", "redis", "postgresql"]
    });

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

    await workerUpdateStep({
      applicationId,
      currentStep: "answers_generated",
      checkpointJson: {
        metadata: {
          ...(metadata ?? {}),
          profile,
          originalResume,
          answers: mergedAnswers
        }
      }
    });

    console.log(`   ✓ Checkpoint written with ${Object.keys(mergedAnswers).length} answers`);
    console.log(`   → Advancing to browser_started`);
    await workerAdvanceStep({ applicationId, nextStep: "browser_started" });
  }
}
