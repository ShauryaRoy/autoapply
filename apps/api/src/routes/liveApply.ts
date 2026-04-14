/**
 * liveApply.ts — v2 (Refactored)
 *
 * Routes:
 *  POST /api/live-apply/generate           — Generate answers for all questions
 *  POST /api/live-apply/regenerate         — Re-generate one question with a regenMode modifier
 *  GET  /api/live-apply/draft/:sessionId   — Load stored draft session
 *  PUT  /api/live-apply/draft/:sessionId   — Save human-approved answers (hash-keyed)
 *  POST /api/live-apply/draft/:sessionId/submit-confirm — Record manual submission
 *
 * v2 changes from liveApply.ts v1:
 *  - Route now loads questionsJson (StoredDraftEntry[]) instead of draftAnswersJson
 *  - Backwards-compatible: falls back to draftAnswersJson if questionsJson is empty
 *  - PUT /draft now accepts questions[] with { questionHash, questionText, answer }
 *  - New POST /regenerate route for single-question refinement with regenMode
 *  - contextFingerprint stored and used for cache invalidation on profile change
 *
 * NEVER auto-submits the application. Human approval is required
 * between this endpoint and any form submission.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../db/prisma.js";
import { getProfileByUserId } from "../services/profileService.js";
import {
  runLiveApply,
  buildSessionId,
  invalidateAnswerCache,
  type DetectedQuestion,
  type StoredDraftEntry,
} from "../services/liveApplyService.js";
import { detectQuestionIntent, normalizeQuestionText } from "../utils/questionHasher.js";
import { env } from "../config/env.js";

// ─────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────

const DetectedQuestionSchema = z.object({
  questionText: z.string().min(1),
  category: z.enum(["free_text", "yes_no", "dropdown", "salary", "upload", "unknown"]),
  fieldHint: z.string().optional(),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(),
});

const JobAnalysisSchema = z
  .object({
    matchedSkills: z.array(z.string()).default([]),
    missingSkills: z.array(z.string()).default([]),
    archetype: z.string().optional(),
    score: z.number().optional(),
  })
  .optional();

const LiveApplyGenerateSchema = z.object({
  jobUrl: z.string().url("jobUrl must be a valid URL"),
  jobTitle: z.string().min(1).default("Unknown Role"),
  companyName: z.string().min(1).default("Unknown Company"),
  jobDescriptionText: z.string().default(""),
  visibleQuestions: z.array(DetectedQuestionSchema).default([]),
  jobAnalysis: JobAnalysisSchema,
});

const LiveApplyRegenSchema = z.object({
  jobUrl: z.string().url(),
  jobTitle: z.string().min(1),
  companyName: z.string().min(1),
  jobDescriptionText: z.string().default(""),
  /** The hash of the specific question to regenerate */
  questionHash: z.string().min(1),
  /** The original question object */
  question: DetectedQuestionSchema,
  /**
   * Regeneration mode — how to modify the answer:
   *  shorter | more_technical | more_direct | more_confident | add_metrics
   */
  regenMode: z.enum(["shorter", "more_technical", "more_direct", "more_confident", "add_metrics"]),
  jobAnalysis: JobAnalysisSchema,
});

/** v2 approved answer entry (hash-keyed) */
const ApprovedAnswerEntrySchema = z.object({
  questionHash: z.string().min(1),
  questionText: z.string().min(1),
  answer: z.string(),
  approvedAt: z.string().optional(),
  qualityScore: z.number().optional(),
});

const SaveDraftSchemaV2 = z.object({
  /** v2: Array of approved answer entries (hash-keyed) */
  questions: z.array(ApprovedAnswerEntrySchema).optional(),
  /** v1 fallback: plain text-keyed map */
  approvedAnswers: z.record(z.string(), z.string()).optional(),
  /** Required for upsert create */
  jobUrl: z.string().optional(),
  jobTitle: z.string().optional(),
  companyName: z.string().optional(),
  /** Context fingerprint for cache invalidation */
  contextFingerprint: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────
// Profile normalisation helper
// ─────────────────────────────────────────────────────────────

function normalizeProfile(profile: Awaited<ReturnType<typeof getProfileByUserId>>) {
  return {
    personal: {
      firstName: profile.firstName ?? "",
      lastName: profile.lastName ?? "",
      email: profile.email ?? "",
      phone: profile.phone ?? undefined,
      location: profile.location ?? undefined,
    },
    experience: (profile.experience ?? []).map((e: any) => ({
      job_title: e.title ?? null,
      company: e.company ?? null,
      description: e.description ?? null,
      start_year: e.startYear ? Number(e.startYear) : null,
      end_year: e.endYear ? Number(e.endYear) : null,
      current: !!e.current,
    })),
    education: (profile.education ?? []).map((e: any) => ({
      institution: e.school ?? null,
      degree: e.degree ?? null,
      field_of_study: e.major ?? null,
    })),
    skills: (profile.skills ?? []).map((s: any) =>
      typeof s === "string" ? s : ((s as { name: string }).name ?? "")
    ),
    links: {
      linkedin: profile.links?.linkedin ?? profile.linkedIn ?? null,
      github: profile.links?.github ?? null,
      portfolio: profile.links?.portfolio ?? profile.portfolio ?? null,
    },
    projects: (profile.projects ?? []).map((p: any) => ({
      name: p.name ?? p.title ?? null,
      description: p.description ?? null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Draft loading helper — v2 with v1 fallback
// ─────────────────────────────────────────────────────────────

async function loadStoredDraftEntries(
  sessionId: string,
  userId: string
): Promise<StoredDraftEntry[]> {
  const session = await prisma.jobDraftSession.findUnique({
    where: { id: sessionId },
  }) as any; // cast: questionsJson + contextFingerprint added in schema but client not yet regenerated

  if (!session || session.userId !== userId) return [];

  // v2: questionsJson contains StoredDraftEntry[]
  const q = session.questionsJson;
  if (Array.isArray(q) && q.length > 0) {
    return q as StoredDraftEntry[];
  }

  // v1 fallback: convert draftAnswersJson ({ questionText: answer }) to StoredDraftEntry[]
  const legacy = session.draftAnswersJson;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    return Object.entries(legacy as Record<string, string>).map(([questionText, answer]) => ({
      questionHash: crypto
        .createHash("sha256")
        .update(questionText.toLowerCase().trim())
        .digest("hex")
        .slice(0, 12),
      questionText,
      answer,
    }));
  }

  return [];
}

// ─────────────────────────────────────────────────────────────
// Router factory
// ─────────────────────────────────────────────────────────────

export function createLiveApplyRouter(): Router {
  const router = Router();

  // ──────────────────────────────────────────────────────────
  // POST /api/live-apply/generate
  // ──────────────────────────────────────────────────────────
  router.post("/generate", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user;
      if (!user) { res.status(401).json({ message: "Unauthorized" }); return; }

      const parsed = LiveApplyGenerateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten().fieldErrors });
        return;
      }
      const input = parsed.data;

      const [profile, storedDraftEntries, learnedAnsRaw] = await Promise.all([
        getProfileByUserId(user.id),
        loadStoredDraftEntries(
          buildSessionId(input.jobUrl, input.companyName, input.jobTitle),
          user.id
        ),
        (prisma as any).userLearnedAnswer.findMany({
          where: { userId: user.id, qualityScore: { gte: 0.65 } },
          orderBy: [{ useCount: "desc" }, { qualityScore: "desc" }],
          take: 20, // Limit context injection to top 20 verified
        }).catch(() => []) as Array<any>,
      ]);
      
      const learnedAnswers = learnedAnsRaw.map((l: any) => ({
        intent: l.intent,
        questionText: l.questionText,
        answerText: l.answerText,
      }));

      const result = await runLiveApply({
        jobUrl: input.jobUrl,
        jobTitle: input.jobTitle,
        companyName: input.companyName,
        jobDescriptionText: input.jobDescriptionText,
        visibleQuestions: input.visibleQuestions as DetectedQuestion[],
        storedDraftEntries,
        learnedAnswers,
        profileSnapshot: normalizeProfile(profile),
        jobAnalysis: input.jobAnalysis,
        geminiApiKey: env.geminiApiKey,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // ──────────────────────────────────────────────────────────
  // POST /api/live-apply/regenerate
  // Regenerates a single question with a targeted regenMode modifier.
  // Returns a single DraftAnswer (not full session).
  // ──────────────────────────────────────────────────────────
  router.post("/regenerate", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user;
      if (!user) { res.status(401).json({ message: "Unauthorized" }); return; }

      const parsed = LiveApplyRegenSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten().fieldErrors });
        return;
      }
      const { jobUrl, jobTitle, companyName, jobDescriptionText, question, questionHash, regenMode, jobAnalysis } = parsed.data;

      const [profile, storedDraftEntries] = await Promise.all([
        getProfileByUserId(user.id),
        loadStoredDraftEntries(buildSessionId(jobUrl, companyName, jobTitle), user.id),
      ]);

      const result = await runLiveApply({
        jobUrl,
        jobTitle,
        companyName,
        jobDescriptionText,
        visibleQuestions: [question as DetectedQuestion],
        storedDraftEntries,
        profileSnapshot: normalizeProfile(profile),
        jobAnalysis,
        regenMode,
        regenQuestionHash: questionHash,
        geminiApiKey: env.geminiApiKey,
      });

      // Return just the single regenerated answer
      const regenerated = result.answers.find((a) => a.questionHash === questionHash);
      if (!regenerated) {
        res.status(404).json({ message: "Regeneration produced no answer for the given questionHash" });
        return;
      }

      res.json({ answer: regenerated, sessionId: result.sessionId });
    } catch (error) {
      next(error);
    }
  });

  // ──────────────────────────────────────────────────────────
  // GET /api/live-apply/draft/:sessionId
  // ──────────────────────────────────────────────────────────
  router.get("/draft/:sessionId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user;
      if (!user) { res.status(401).json({ message: "Unauthorized" }); return; }

      const { sessionId } = req.params;
      const session = await prisma.jobDraftSession.findUnique({ where: { id: sessionId } }) as any;

      if (!session || session.userId !== user.id) {
        res.json({ sessionId, questions: [], approvedAnswers: {}, exists: false });
        return;
      }

      res.json({
        sessionId: session.id,
        jobUrl: session.jobUrl,
        jobTitle: session.jobTitle,
        companyName: session.companyName,
        questions: session.questionsJson ?? [],
        /** v1 compat field */
        approvedAnswers: session.draftAnswersJson ?? {},
        contextFingerprint: session.contextFingerprint,
        submittedAt: session.submittedAt,
        exists: true,
      });
    } catch (error) {
      next(error);
    }
  });

  // ──────────────────────────────────────────────────────────
  // PUT /api/live-apply/draft/:sessionId
  // Save human-approved answers. Accepts v2 (questions[]) or
  // v1 (approvedAnswers{}) format.
  // ──────────────────────────────────────────────────────────
  router.put("/draft/:sessionId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user;
      if (!user) { res.status(401).json({ message: "Unauthorized" }); return; }

      const { sessionId } = req.params;

      const parsed = SaveDraftSchemaV2.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten().fieldErrors });
        return;
      }

      const {
        questions,
        approvedAnswers,
        jobUrl,
        jobTitle,
        companyName,
        contextFingerprint,
      } = parsed.data;

      // v2 path: questions[]
      const questionsJson: any[] = questions
        ? questions.map((q) => ({
            questionHash: q.questionHash,
            questionText: q.questionText,
            answer: q.answer,
            approvedAt: q.approvedAt ?? new Date().toISOString(),
            qualityScore: q.qualityScore ?? 0,
          }))
        : [];

      // v1 compat: if no questions[], derive from approvedAnswers{}
      const legacyAnswers = questions ? {} : (approvedAnswers ?? {});

      // Invalidate in-memory cache if fingerprint changed
      const oldSession = await prisma.jobDraftSession.findUnique({
        where: { id: sessionId },
        select: { contextFingerprint: true },
      }) as any;

      if (oldSession && oldSession.contextFingerprint !== contextFingerprint) {
        invalidateAnswerCache(oldSession.contextFingerprint);
      }

      // Upsert the session natively
      const savedSession = await prisma.jobDraftSession.upsert({
        where: { id: sessionId },
        create: {
          id: sessionId,
          userId: user.id,
          jobUrl: jobUrl ?? "",
          companyName: companyName ?? "",
          jobTitle: jobTitle ?? "",
          draftAnswersJson: (prisma as any)._missing ? legacyAnswers : legacyAnswers, 
        } as any, // Cast because questionsJson / contextFingerprint are missing in type bindings
        update: {
          questionsJson: questionsJson as any,
          contextFingerprint: contextFingerprint ?? null,
        } as any,
      });

      // V3: Learning Loop Update
      // Upsert answers to UserLearnedAnswer base, keyed by intent
      if (questionsJson.length > 0) {
        // Attempt upserts asynchronously (don't block the UI response)
        Promise.all(questionsJson.map(async (q) => {
          if (!q.answer || q.answer.length < 5) return;
          const intent = detectQuestionIntent(normalizeQuestionText(q.questionText));
          if (intent === "custom") return; // don't learn strictly custom unique stuff
          
          try {
              // Find existing
             const existing = await (prisma as any).userLearnedAnswer.findFirst({
               where: { userId: user.id, intent }
             });
             if (existing) {
                // If it's the exact same answer, just increment useCount
                if (existing.answerText.trim() === q.answer.trim()) {
                   await (prisma as any).userLearnedAnswer.update({
                      where: { id: existing.id },
                      data: { useCount: { increment: 1 }, qualityScore: q.qualityScore ?? existing.qualityScore }
                   });
                } else {
                   // User overwrote it with a new one for this intent — update it entirely and reset count 
                   await (prisma as any).userLearnedAnswer.update({
                      where: { id: existing.id },
                      data: { answerText: q.answer.trim(), questionText: q.questionText, useCount: 1, qualityScore: q.qualityScore ?? 0 }
                   });
                }
             } else {
               await (prisma as any).userLearnedAnswer.create({
                 data: {
                   userId: user.id,
                   intent,
                   questionText: q.questionText,
                   answerText: q.answer.trim(),
                   useCount: 1,
                   qualityScore: q.qualityScore ?? 0
                 }
               });
             }
          } catch (e) {
             console.warn("[LiveApply] Could not update learned answer:", e);
          }
        })).catch(err => console.error("Learning loop save error:", err));
      }

      res.json({ message: "Draft saved.", sessionId: savedSession.id });
    } catch (error) {
      next(error);
    }
  });

  // ──────────────────────────────────────────────────────────
  // POST /api/live-apply/draft/:sessionId/submit-confirm
  // Human confirmation checkpoint — records that the user
  // manually submitted the form. NEVER auto-submits.
  // ──────────────────────────────────────────────────────────
  router.post(
    "/draft/:sessionId/submit-confirm",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const user = req.user;
        if (!user) { res.status(401).json({ message: "Unauthorized" }); return; }

        const { sessionId } = req.params;
        const session = await prisma.jobDraftSession.findUnique({ where: { id: sessionId } });

        if (!session || session.userId !== user.id) {
          res.status(404).json({ message: "Draft session not found" });
          return;
        }

        await prisma.jobDraftSession.update({
          where: { id: sessionId },
          data: { submittedAt: new Date() },
        });

        res.json({ sessionId, submittedAt: new Date().toISOString() });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}
