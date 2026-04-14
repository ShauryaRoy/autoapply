/**
 * job.ts — POST /api/job/analyze
 *
 * Accepts a raw job description (plus optional user profile data) and
 * returns structured job intelligence in a machine-friendly shape:
 *
 *   {
 *     "job":      { title, company, remotePolicy, archetype, seniority },
 *     "analysis": { score (0-100), decision, apply_priority, matched_skills,
 *                   missing_skills, risk_flags, match_score, score_breakdown },
 *     "details":  { roleSummary, cvMatch, ghostRisk }
 *   }
 *
 * Logic ported from Career-Ops (oferta.md Blocks A, B, G).
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  detectArchetype,
  detectSeniority,
  detectRemotePolicy,
  detectDomain,
  detectFunction,
  extractSkills,
  extractKeywords,
  matchCvToJd,
  analyzeGhostRisk,
  buildTldr,
  buildAnalysisSummary,
} from "../services/jobIntelligenceService.js";

// ─────────────────────────────────────────────────────────────
// Request validation schema
// ─────────────────────────────────────────────────────────────

const AnalyzeJobSchema = z.object({
  /** Raw job description text (pasted or scraped) */
  jobDescription: z.string().min(50, "Job description must be at least 50 characters"),

  /** Company name — used in TL;DR and ghost risk signals */
  companyName: z.string().optional().default("Unknown Company"),

  /** Job title if available separately (improves archetype detection) */
  jobTitle: z.string().optional().default(""),

  /**
   * Optional: user's profile text (resume text or skills list string)
   * Used for CV/JD match scoring.
   */
  profileText: z.string().optional().default(""),

  /**
   * Optional: explicit list of skills from user's profile
   * Augments profileText for match accuracy.
   */
  profileSkills: z.array(z.string()).optional().default([]),

  /**
   * Optional ghost-risk signals that are expensive to compute server-side
   * but easy for the client/worker to capture.
   */
  ghostRiskHints: z
    .object({
      /** How old the posting is in days. null = unknown */
      postingAgeDays: z.number().nullable().optional(),
      /** Was there a visible Apply button on the page? */
      hasApplyButton: z.boolean().optional(),
      /** Number of times this company+role combo appeared in scan history */
      repostCount: z.number().optional(),
    })
    .optional()
    .default({}),

  /**
   * Optional: user's preferred remote policies for scoring penalty.
   * Defaults to fully-remote only.
   */
  preferredRemotePolicies: z
    .array(z.enum(["fully-remote", "hybrid", "onsite", "geo-restricted", "unknown"]))
    .optional()
    .default(["fully-remote"]),
});

type AnalyzeJobRequest = z.infer<typeof AnalyzeJobSchema>;

// ─────────────────────────────────────────────────────────────
// Route factory
// ─────────────────────────────────────────────────────────────

export function createJobRouter(): Router {
  const router = Router();

  /**
   * POST /api/job/analyze
   *
   * Analyzes a job description and returns structured intelligence.
   *
   * @example
   * POST /api/job/analyze
   * {
   *   "jobDescription": "We are looking for a Senior ML Engineer...",
   *   "companyName": "Acme AI",
   *   "jobTitle": "Senior ML Engineer",
   *   "profileText": "5 years of Python, PyTorch, RAG systems...",
   *   "profileSkills": ["Python", "PyTorch", "LangChain"],
   *   "ghostRiskHints": { "postingAgeDays": 12, "hasApplyButton": true }
   * }
   */
  router.post("/analyze", async (req: Request, res: Response, next: NextFunction) => {
    try {
      // ── 1. Validate input ──────────────────────────────────
      const parseResult = AnalyzeJobSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          message: "Invalid request body",
          errors: parseResult.error.flatten().fieldErrors,
        });
        return;
      }

      const input: AnalyzeJobRequest = parseResult.data;
      const jd = input.jobDescription;

      // ── 2. Block A — Role Summary ──────────────────────────
      const { primary: archetype, secondary: secondaryArchetype } = detectArchetype(jd);
      const seniority = detectSeniority(jd);
      const remotePolicy = detectRemotePolicy(jd);
      const domain = detectDomain(jd);
      const jobFunction = detectFunction(jd);

      const titleForDisplay = input.jobTitle || "the role";
      const tldr = buildTldr({
        jobTitle: titleForDisplay,
        companyName: input.companyName,
        archetype,
        seniority,
        remotePolicy,
      });

      const roleSummary = {
        archetype,
        secondaryArchetype,
        seniority,
        remotePolicy,
        domain,
        function: jobFunction,
        tldr,
      };

      // ── 3. Skill + Keyword Extraction ──────────────────────
      const jdSkills = extractSkills(jd);
      const keywords = extractKeywords(jd);

      // ── 4. Block B — CV/JD Match ───────────────────────────
      const cvMatch = matchCvToJd(
        { required: jdSkills.required, preferred: jdSkills.preferred },
        input.profileSkills,
        input.profileText
      );

      // ── 5. Block G — Ghost / Legitimacy Risk ───────────────
      const ghostRisk = analyzeGhostRisk({
        jdText: jd,
        jobTitle: titleForDisplay,
        companyName: input.companyName,
        postingAgedays: input.ghostRiskHints.postingAgeDays ?? null,
        hasApplyButton: input.ghostRiskHints.hasApplyButton,
        repostCount: input.ghostRiskHints.repostCount ?? 0,
      });

      // ── 6. Decision layer — deterministic normalized formula ─
      const analysis = buildAnalysisSummary({
        cvMatch,
        ghostRisk,
        keywords,
        profileText: input.profileText,
        jdText: jd,
        remotePolicy,
        seniority,
        jdSkillCount: jdSkills.all.length,
      });

      // ── 8. Return structured response ──────────────────────
      res.json({
        /** Lightweight job identity block — safe to store/index */
        job: {
          title: titleForDisplay,
          company: input.companyName,
          remotePolicy,
          archetype,
          seniority,
          domain,
          tldr,
        },

        /**
         * Machine-friendly analysis block.
         * score    : 0-100 normalised
         * decision : APPLY | RISKY | SKIP
         * priority : HIGH | MEDIUM | LOW
         */
        analysis,

        /**
         * Full detail blocks — used by UI and human review.
         * Preserved unchanged from the original intelligence engine.
         */
        details: {
          roleSummary,
          requiredSkills: jdSkills.required,
          preferredSkills: jdSkills.preferred,
          keywords,
          cvMatch: {
            ...cvMatch,
            /** Normalized alias so clients don't need to convert */
            match_score: analysis.match_score,
          },
          ghostRisk,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

