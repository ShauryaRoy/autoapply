/**
 * resume.ts — POST /api/resume/patch
 *
 * Accepts a structured resume + job data and returns
 * patched bullet points with diff metadata.
 *
 * Each bullet is:
 *   1. Matched against JD keywords (bulletMatcher.ts)
 *   2. If injectable keywords exist → LLM patches it
 *   3. Patch validated by validator.ts (5-rule safety gate)
 *   4. On any failure → original bullet returned unchanged
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { patchResume } from "../services/resumePatchService.js";
import { parseResumeWithAI } from "../services/resumeAiParserService.js";
import { env } from "../config/env.js";

// ─────────────────────────────────────────────────────────────
// Request schema
// ─────────────────────────────────────────────────────────────

const ExperienceEntrySchema = z.object({
  role: z.string().default(""),
  company: z.string().default(""),
  bullets: z.array(z.string().min(1)).min(1, "Each experience entry must have at least one bullet"),
});

const ResumePatchSchema = z.object({
  resume: z.object({
    experience: z
      .array(ExperienceEntrySchema)
      .min(1, "resume.experience must contain at least one entry"),
  }),

  job: z.object({
    /** Required skills from JD — direct matching targets */
    skills_required: z.array(z.string()).optional().default([]),
    /** Domain/ATS keywords extracted from JD */
    keywords: z.array(z.string()).optional().default([]),
  }),

  /** Optional: override the Gemini model used for patching */
  model: z.string().optional(),
});

type ResumePatchRequest = z.infer<typeof ResumePatchSchema>;

const ResumeAiParseSchema = z.object({
  text: z.string().min(1, "text is required"),
  jobId: z.string().optional(),
  model: z.string().optional()
});

// ─────────────────────────────────────────────────────────────
// Route factory
// ─────────────────────────────────────────────────────────────

export function createResumeRouter(): Router {
  const router = Router();

  router.post("/parse-ai", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ResumeAiParseSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          message: "Invalid request body",
          errors: parsed.error.flatten().fieldErrors
        });
        return;
      }

      const input = parsed.data;

      const parsedResume = await parseResumeWithAI(input.text, {
        geminiApiKey: env.geminiApiKey,
        geminiModel: input.model
      });

      if (!parsedResume || !("projects" in parsedResume)) {
        res.json({ parsedResume: null, fallback: true });
        return;
      }

      res.json({ parsedResume, fallback: false });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/resume/patch
   *
   * @example
   * {
   *   "resume": {
   *     "experience": [
   *       {
   *         "role": "ML Engineer",
   *         "company": "Acme AI",
   *         "bullets": [
   *           "Built retrieval pipeline for document QA using LLM workflows",
   *           "Deployed model serving infrastructure on GCP"
   *         ]
   *       }
   *     ]
   *   },
   *   "job": {
   *     "skills_required": ["Python", "RAG", "LangChain"],
   *     "keywords": ["MLOps", "embeddings", "vector search"]
   *   }
   * }
   *
   * @returns
   * {
   *   "patched_bullets": [
   *     {
   *       "original": "...",
   *       "updated": "...",
   *       "keywords_added": ["RAG", "embeddings"],
   *       "patched": true
   *     }
   *   ],
   *   "stats": { "total": 2, "patched": 1, "skipped": 1, "rejected": 0 }
   * }
   */
  router.post("/patch", async (req: Request, res: Response, next: NextFunction) => {
    try {
      // ── Validate ─────────────────────────────────────────────
      const parsed = ResumePatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          message: "Invalid request body",
          errors: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const input: ResumePatchRequest = parsed.data;

      // ── Guard: need JD signals ─────────────────────────────
      const totalSignals =
        input.job.skills_required.length + input.job.keywords.length;
      if (totalSignals === 0) {
        res.status(400).json({
          message: "Provide at least one item in job.skills_required or job.keywords",
        });
        return;
      }

      // ── Run patch engine ───────────────────────────────────
      const result = await patchResume({
        experience: input.resume.experience,
        skillsRequired: input.job.skills_required,
        keywords: input.job.keywords,
        geminiApiKey: env.geminiApiKey,
        geminiModel: input.model,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
