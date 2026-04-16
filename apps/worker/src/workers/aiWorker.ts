import type { Job } from "bullmq";
import { workerAdvanceStep, workerLogEvent, workerUpdateStep } from "../lib/apiClient.js";
import { GeminiService } from "../lib/ai/geminiService.js";
import { analyzeJob } from "../automation/tailor/jobAnalyzer.js";
import { buildResumeCanonical, isTailored, tailorResume, validateResumeCanonical } from "../automation/tailor/resumeTailor.js";
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
  void originalResumeText;
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
    },
    {
      section: "experience",
      added: canonical.experience.flatMap((entry) => entry.bullets),
      reason: "Rewrote experience bullets with JD keywords."
    }
  ];
}

function dedupeKeywords(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  values.forEach((value) => {
    const cleaned = value.trim();
    if (!cleaned) return;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    output.push(cleaned);
  });

  return output;
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

    // Use the real scraped job description if available, otherwise build a synthetic one
    const scrapedJobDescription = typeof metadata?.jobDescription === "string" && metadata.jobDescription.trim().length > 50
      ? metadata.jobDescription.trim()
      : null;

    const syntheticJd = scrapedJobDescription ?? [
      `Job Title: ${targetRole ?? "Unknown"}`,
      `Target URL: ${jobUrl ?? "Unknown"}`,
      `Keywords: ${(jobInsights.keywords ?? []).join(", ")}`,
      `Required skills: ${(jobInsights.skillGaps ?? []).join(", ")}`,
      `This role requires collaboration, production system ownership, and measurable delivery outcomes.`,
    ].join("\n");

    let resumeCanonical: ResumeCanonical | null = null;
    let tailoringError: string | null = null;
    let requiredSkills: string[] = [];
    let preferredSkills: string[] = [];
    let extractedKeywords: string[] = [];
    const shouldTailor = true;

    await workerLogEvent({
      applicationId,
      step: "resume_optimized",
      message: "Tailoring triggered",
      payloadJson: {
        heuristicScore,
        threshold: AUTO_APPLY_THRESHOLD,
        tailoringTriggered: shouldTailor,
        usedScrapedJd: Boolean(scrapedJobDescription),
      }
    });

    try {
      const jobProfile = await analyzeJob({ jobDescription: syntheticJd });

      requiredSkills = dedupeKeywords([
        ...jobProfile.skills,
        ...(jobInsights.keywords ?? [])
      ]).slice(0, 10);

      preferredSkills = dedupeKeywords([
        ...jobProfile.keywords,
        ...(jobInsights.skillGaps ?? [])
      ]).slice(0, 10);

      extractedKeywords = dedupeKeywords([
        ...requiredSkills,
        ...preferredSkills
      ]);

      const canonical = await tailorResume({
        originalResume,
        jobDescription: syntheticJd,
        requiredSkills,
        preferredSkills
      });

      canonical.version = 1;
      canonical.generatedFor = targetRole ?? jobProfile.role;
      canonical.generatedAt = new Date().toISOString();

      validateResumeCanonical(canonical, extractedKeywords);
      if (!isTailored(canonical, syntheticJd)) {
        throw new Error("Canonical resume is not JD-optimized");
      }

      const computed = buildResumeCanonical(canonical);
      if (computed !== canonical.rawText) {
        throw new Error("Canonical mismatch - blocking PDF generation");
      }

      resumeCanonical = canonical;

      console.log({
        tailoringTriggered: shouldTailor,
        canonicalSkills: resumeCanonical.skills,
        jdKeywords: extractedKeywords
      });

      await workerLogEvent({
        applicationId,
        step: "resume_optimized",
        message: "Tailored canonical resume generated",
        payloadJson: {
          diff: buildStructuredDiff(originalResume, resumeCanonical),
          resumeCanonical,
          originalResume,
          version: resumeCanonical.version,
          tailoringTriggered: shouldTailor,
          fallbackUsed: false,
          threshold: AUTO_APPLY_THRESHOLD,
          scoreBefore: Math.round(optimization.scoreBefore * 100),
          scoreAfter: heuristicScore,
          requiredSkills,
          preferredSkills,
          jdKeywords: extractedKeywords,
          canonicalReady: true
        }
      });
    } catch (error) {
      tailoringError = error instanceof Error ? error.message : String(error);
      await workerLogEvent({
        applicationId,
        step: "resume_optimized",
        message: "Tailoring failed - canonical not updated",
        payloadJson: {
          error: tailoringError,
          tailoringError,
          resumeCanonical: null,
          originalResume,
          version: 0,
          tailoringTriggered: true,
          fallbackUsed: true,
          threshold: AUTO_APPLY_THRESHOLD,
          scoreBefore: Math.round(optimization.scoreBefore * 100),
          scoreAfter: heuristicScore,
          requiredSkills,
          preferredSkills,
          jdKeywords: extractedKeywords,
          canonicalReady: false
        }
      });

      await workerUpdateStep({
        applicationId,
        currentStep: "resume_optimized",
        status: "failed",
        checkpointJson: {
          metadata: {
            ...(metadata ?? {}),
            originalResume,
            resumeCanonical: null,
            resumeHistory: metadata?.resumeHistory ?? [],
            resumeVersion: 0,
            tailoringTriggered: true,
            tailoringThreshold: AUTO_APPLY_THRESHOLD,
            tailoringError,
            fallbackUsed: false,
            requiredSkills,
            preferredSkills,
            jdKeywords: extractedKeywords,
            canonicalReady: false
          }
        }
      });

      throw new Error("Canonical resume is not JD-optimized");
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
          fallbackUsed: false,
          requiredSkills,
          preferredSkills,
          jdKeywords: extractedKeywords,
          canonicalReady: true
        }
      }
    });

    await workerAdvanceStep({ applicationId, nextStep: "answers_generated" });
    return;
  }

  if (step === "answers_generated") {
    console.log(`\n🧠 [aiWorker] step=answers_generated appId=${applicationId}`);

    const jobInsights = (metadata?.jobInsights as { keywords?: string[]; skillGaps?: string[]; relevanceScore?: number } | undefined) ?? {};
    const scrapedJobDescription = typeof metadata?.jobDescription === "string" && metadata.jobDescription.trim().length > 50
      ? metadata.jobDescription.trim()
      : null;
    const syntheticJd = scrapedJobDescription ?? [
      `Job Title: ${targetRole ?? "Unknown"}`,
      `Target URL: ${jobUrl ?? "Unknown"}`,
      `Keywords: ${(jobInsights.keywords ?? []).join(", ")}`,
    ].join("\n");

    const resumeCanonical = metadata?.resumeCanonical as {
      summary?: string;
      skills?: string[];
      experience?: Array<{ title: string; bullets: string[] }>;
      projects?: Array<{ title: string; bullets: string[] }>;
    } | null | undefined;

    const generatedAnswers = await gemini.generateFormAnswers({
      targetRole,
      jobDescription: syntheticJd,
      resumeText: originalResume,
      resumeCanonical: resumeCanonical ?? null,
      profile,
      keywords: [
        ...(jobInsights.keywords ?? []),
        ...(jobInsights.skillGaps ?? []),
      ].slice(0, 10),
    });

    const mergedAnswers = {
      ...generatedAnswers.answers,
      "why-this-company": generatedAnswers.whyThisCompany || generatedAnswers.answers["why-this-company"] || "",
      "years-experience": generatedAnswers.yearsExperience || generatedAnswers.answers["years-experience"] || "",
      "cover-letter": generatedAnswers.coverLetter || "",
      ...customAnswers,
    };

    await workerLogEvent({
      applicationId,
      step: "answers_generated",
      message: "Form answers and cover letter generated",
      payloadJson: {
        coverLetter: generatedAnswers.coverLetter,
        answers: mergedAnswers,
      },
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
