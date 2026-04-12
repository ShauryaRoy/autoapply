/**
 * contextBuilder.ts
 *
 * Builds compressed, high-signal context for application answer generation.
 * Pulls from:
 *  - Job identity & keywords
 *  - Resume extracted text
 *  - Patched bullets (from Resume Patch Engine)
 */

export interface AppContextParams {
  job: {
    title: string;
    company: string;
    domain?: string;
  };
  analysis: {
    matched_skills: string[];
    missing_skills: string[];
  };
  resume: any;
  patched_bullets: { original: string; updated: string; keywords_added: string[]; patched: boolean }[];
}

export interface ApplicationContext {
  jobRole: string;
  jobCompany: string;
  jobDomain: string;
  matchedSkills: string[];
  missingSkills: string[];
  resumeHighlights: string[];
}

export function buildApplicationContext(params: AppContextParams): ApplicationContext {
  const { job, analysis, patched_bullets } = params;

  // Ensure uniqueness by checking substrings
  const uniqueHighlights = new Set<string>();
  const addIfUnique = (bullet: string) => {
    // Basic deduplication: check if this is exactly the same or very similar (simple inclusion check)
    // to any existing highlight
    for (const existing of uniqueHighlights) {
      if (existing.includes(bullet) || bullet.includes(existing)) {
        return false;
      }
    }
    uniqueHighlights.add(bullet);
    return true;
  };

  // Extract high-signal bullets (preferably patched ones that matched JD)
  for (const b of patched_bullets) {
    if (b.patched || b.keywords_added.length > 0) {
      addIfUnique(b.updated);
    }
    if (uniqueHighlights.size >= 5) break;
  }

  // If we need more to reach min 3, add unpatched bullets from the structure
  if (uniqueHighlights.size < 3 && params.resume?.experience) {
    for (const exp of params.resume.experience) {
      if (exp.bullets && Array.isArray(exp.bullets)) {
        for (const bullet of exp.bullets) {
          addIfUnique(bullet);
          if (uniqueHighlights.size >= 5) break; 
        }
      }
      if (uniqueHighlights.size >= 5) break; 
    }
  }

  const finalHighlights = Array.from(uniqueHighlights).slice(0, 5);

  return {
    jobRole: job.title || "the role",
    jobCompany: job.company || "the company",
    jobDomain: job.domain || "the industry",
    matchedSkills: analysis.matched_skills || [],
    missingSkills: analysis.missing_skills || [],
    resumeHighlights: finalHighlights
  };
}

export function formatContextForPrompt(ctx: ApplicationContext): string {
  return `
ROLE: ${ctx.jobRole} at ${ctx.jobCompany} (${ctx.jobDomain})
MATCHED SKILLS: ${ctx.matchedSkills.join(", ")}
MISSING SKILLS (Do NOT claim these): ${ctx.missingSkills.join(", ")}
RESUME HIGHLIGHTS (Use these as proof):
${ctx.resumeHighlights.map(h => `- ${h}`).join("\n")}
  `.trim();
}
