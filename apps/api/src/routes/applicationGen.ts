/**
 * application.ts — POST /api/application/generate
 *
 * Exposes the Application Intelligence Service to generate form-ready
 * answers for a job application using job data, analysis, and a parsed resume.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { generateApplicationAnswers } from "../services/applicationService.js";
import { env } from "../config/env.js";

// ─────────────────────────────────────────────────────────────
// Request validation schema
// ─────────────────────────────────────────────────────────────

const GenerateAppSchema = z.object({
  job: z.object({
    title: z.string().default(""),
    company: z.string().default(""),
    domain: z.string().optional()
  }),
  analysis: z.object({
    matched_skills: z.array(z.string()).default([]),
    missing_skills: z.array(z.string()).default([])
  }),
  resume: z.any(), // Flexible to accept standard parsed resume object
  patched_bullets: z.array(
    z.object({
      original: z.string(),
      updated: z.string(),
      keywords_added: z.array(z.string()).default([]),
      patched: z.boolean().default(false)
    })
  ).default([])
});

type GenerateAppRequest = z.infer<typeof GenerateAppSchema>;

// ─────────────────────────────────────────────────────────────
// Route factory
// ─────────────────────────────────────────────────────────────

export function createApplicationGenRouter(): Router {
  const router = Router();

  /**
   * POST /api/application/generate
   */
  router.post("/generate", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = GenerateAppSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          message: "Invalid request body",
          errors: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const input: GenerateAppRequest = parsed.data;

      const result = await generateApplicationAnswers({
        job: input.job,
        analysis: input.analysis,
        resume: input.resume,
        patched_bullets: input.patched_bullets,
        geminiApiKey: env.geminiApiKey,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
