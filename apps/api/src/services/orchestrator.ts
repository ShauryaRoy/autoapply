import type { Job } from "bullmq";
import type { AppQueuePayload } from "../queue/applicationQueue.js";
import { addAutomationJob } from "../queue/applicationQueue.js";
import { 
  detectArchetype, detectSeniority, detectRemotePolicy, 
  extractSkills, extractKeywords, matchCvToJd, 
  analyzeGhostRisk, computeOverallScore, buildAnalysisSummary 
} from "./jobIntelligenceService.js";
import { patchResume } from "./resumePatchService.js";
import { generateApplicationAnswers } from "./applicationService.js";
import { runAutomation } from "./automationService.js";
import { env } from "../config/env.js";
import { initQueueJobState, updateQueueJobState } from "../db/queueDb.js";
import pLimit from "p-limit";

// Rate Limiters to protect system overload
const llmLimiter = pLimit(5);
const browserLimiter = pLimit(2);

function withTimeout<T>(promise: Promise<T>, ms: number = 30000, stepName: string = "unknown", state?: any): Promise<T> {
  let timeoutHandle: NodeJS.Timeout;
  const start = Date.now();
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Step Timeout limit exceeded (${ms}ms)`)), ms);
  });
  return Promise.race([
    promise.finally(() => {
      clearTimeout(timeoutHandle);
      if (state) {
        state.result.metrics = state.result.metrics || { steps: {} };
        state.result.metrics.steps[stepName] = Date.now() - start;
      }
    }),
    timeoutPromise
  ]);
}

export async function processApplicationJob(job: Job<AppQueuePayload>): Promise<any> {
  const state = await initQueueJobState(job.data.job_id, job.data.user_id, job.data.job_url);

  const logInfo = (msg: string) => {
    console.log(`[Orchestrator ${job.data.job_id}] ${msg}`);
    state.result.logs = state.result.logs || [];
    state.result.logs.push(`{"step": "AI Pipeline", "action": "info", "status": "ok", "timestamp": "${new Date().toISOString()}", "msg": "${msg}"}`);
  };

  const logErr = (msg: string) => {
    console.error(`[Orchestrator ${job.data.job_id}] ERROR: ${msg}`);
    state.errors.push(msg);
  };

  try {
    // -----------------------------------------------------------------
    // STEP 1: ANALYZE JOB 
    // -----------------------------------------------------------------
    if (!state.steps.analyze) {
      state.status = "RUNNING";
      await updateQueueJobState(state);
      logInfo("Starting STEP 1: Job Intelligence");
      
      const analysisOutput = await withTimeout((async () => {
        const jdText = "Generic Job Description Context for " + job.data.job_url;
        const skills = extractSkills(jdText);
        const keywords = extractKeywords(jdText);
        const cvMatch = matchCvToJd(skills, job.data.resume?.skills || [], JSON.stringify(job.data.resume));
        const ghostRisk = analyzeGhostRisk({ jdText, jobTitle: "Role", companyName: "Company" });
        const remotePolicy = detectRemotePolicy(jdText);
        const overallScore = computeOverallScore({ cvMatchScore: cvMatch.matchScoreEstimate, ghostRisk, remotePolicy });
        
        return buildAnalysisSummary({
          overallScore, cvMatch, ghostRisk, remotePolicy, seniority: detectSeniority(jdText),
          jdSkillCount: skills.all.length, keywords, profileText: JSON.stringify(job.data.resume)
        });
      })(), 30000, "analyze", state);

      state.steps.analyze = analysisOutput;
      await updateQueueJobState(state);
      logInfo("STEP 1 SUCCESS");
      await job.updateProgress(33);
    } else {
      logInfo("Skipping STEP 1 (Already completed)");
    }

    // -----------------------------------------------------------------
    // STEP 2: PATCH RESUME
    // -----------------------------------------------------------------
    if (!state.steps.patched_resume) {
      logInfo("Starting STEP 2: Resume Patch");
      let experience = job.data.resume?.experience || [];
      if (!Array.isArray(experience)) experience = [experience];
      
      const patchOutput = await llmLimiter(() => withTimeout(patchResume({
        experience: experience.map((exp: any) => ({ role: exp.title || "Role", company: exp.company || "Company", bullets: exp.bullets || [] })),
        skillsRequired: state.steps.analyze.missing_skills || [],
        keywords: extractKeywords("Target context"),
        geminiApiKey: env.geminiApiKey || process.env.GEMINI_API_KEY || "dummy", 
      }), 45000, "patched_resume", state)); // LLM can be slightly slower

      state.steps.patched_resume = patchOutput;
      await updateQueueJobState(state);
      logInfo("STEP 2 SUCCESS");
      await job.updateProgress(66);
    } else {
      logInfo("Skipping STEP 2 (Already completed)");
    }

    // -----------------------------------------------------------------
    // STEP 3: GENERATE APPLICATION ANSWERS
    // -----------------------------------------------------------------
    if (!state.steps.answers) {
      logInfo("Starting STEP 3: Application Intelligence");
      const answerOutput = await llmLimiter(() => withTimeout(generateApplicationAnswers({
        job: { title: "Target Role", company: "Target Company", domain: "General Tech" },
        analysis: {
          matched_skills: state.steps.analyze.matched_skills || [],
          missing_skills: state.steps.analyze.missing_skills || []
        },
        resume: job.data.resume,
        patched_bullets: state.steps.patched_resume.patched_bullets || [],
        geminiApiKey: env.geminiApiKey || process.env.GEMINI_API_KEY || "dummy",
      }), 60000, "answers", state));

      state.steps.answers = answerOutput;
      await updateQueueJobState(state);
      logInfo("STEP 3 SUCCESS");
      await job.updateProgress(100);
    } else {
      logInfo("Skipping STEP 3 (Already completed)");
    }

    // SUCCESS - Push to Automation Worker
    logInfo("AI Pipeline completed. Forwarding to Automation Queue...");
    
    // Inject generated answers into payload for the next queue
    const automationPayload = {
      ...job.data,
      status: state.steps.answers, // Embed generated
    };
    const autoJob = await addAutomationJob(automationPayload, state.steps.analyze.score || 50);

    state.result.queue_link = {
      parent_job_id: job.id,
      automation_job_id: autoJob.id
    };
    await updateQueueJobState(state);

    return { status: "SUCCESS" };

  } catch (err: any) {
    logErr(err.message);
    state.status = "FAILED";
    await updateQueueJobState(state);
    throw err;
  }
}

export async function processAutomationJob(job: Job<AppQueuePayload>): Promise<any> {
  const state = await initQueueJobState(job.data.job_id, job.data.user_id, job.data.job_url);

  const logInfo = (msg: string) => {
    console.log(`[Auto Worker ${job.data.job_id}] ${msg}`);
    state.result.logs = state.result.logs || [];
    state.result.logs.push(`{"step": "Automation", "action": "info", "status": "ok", "timestamp": "${new Date().toISOString()}", "msg": "${msg}"}`);
  };

  if (state.steps.apply) {
    logInfo("Skipping Automation Phase (Already completed)");
    return { status: "SUCCESS" };
  }

  try {
    logInfo("Starting Automation Engine execution...");
    const answersData = job.data.status || {};
    
    // Explicit extended timeout for playwright, bracketed by concurrency limits
    const autoResult = await browserLimiter(() => withTimeout(runAutomation(job.data.job_url, {
      user_profile: {
        name: job.data.user_profile.name || "Candidate Name",
        email: job.data.user_profile.email || "candidate@email.com",
        phone: job.data.user_profile.phone || "555-0000",
        linkedin_url: job.data.user_profile.linkedin || "",
        portfolio_url: job.data.user_profile.portfolio || "",
      },
      answers: {
        summary: answersData.summary,
        why_role: answersData.why_role,
        ...answersData.answers
      },
      resume_path: job.data.resume_path || ""
    }), 120000, "apply", state)); // 2 minutes

    if (autoResult.status === "FAILED") {
       throw new Error(`Automation Engine internal crash: ${autoResult.errors.join("; ")}`);
    }

    state.steps.apply = autoResult;
    state.status = "COMPLETED";
    await updateQueueJobState(state);
    logInfo("Automation applied successfully!");

    return { status: "SUCCESS" };
  } catch(err: any) {
    console.error(`[Auto Worker] Error: ${err.message}`);
    state.errors.push(err.message);
    
    // Check if previous 3 steps succeeded to assign partial success
    if (state.steps.analyze && state.steps.patched_resume && state.steps.answers) {
      state.status = "PARTIAL_SUCCESS";
      logInfo("Browser engine crashed, but AI generation preserved as PARTIAL_SUCCESS.");
    } else {
      state.status = "FAILED";
    }
    
    await updateQueueJobState(state);
    throw err;
  }
}
