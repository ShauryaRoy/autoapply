/**
 * fieldMapper.ts
 *
 * Maps detected ATS form fields to user payload data using fuzzy logic.
 */

import type { FormField } from "./formDetector.js";

export interface AutomationPayload {
  user_profile: {
    name: string;
    email: string;
    phone: string;
    linkedin_url?: string;
    portfolio_url?: string;
  };
  answers: {
    why_role?: string;
    why_company?: string;
    experience?: string;
    strengths?: string;
    summary?: string;
    custom?: Record<string, string>;
    [key: string]: any;
  };
  resume_path?: string;
}

export interface MappedField {
  field: FormField;
  value: string;
  action: "type" | "select" | "upload" | "skip";
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function computeSimilarity(s1: string, s2: string): number {
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;
  
  const matrix: number[][] = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(null));
  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  const distance = matrix[len1][len2];
  const maxLen = Math.max(len1, len2);
  return 1 - distance / maxLen;
}

export function mapFields(fields: FormField[], payload: AutomationPayload): MappedField[] {
  const mapped: MappedField[] = [];

  const THRESHOLD = 0.55;

  for (const field of fields) {
    const normLabel = normalizeTitle(field.label || field.placeholder || field.name);
    
    let matchedValue = "";
    let action: MappedField["action"] = "type";
    
    // Hardcoded patterns that override purely fuzzy (like Resume)
    if (field.type === "file" && (normLabel.includes("resume") || normLabel.includes("cv"))) {
      if (payload.resume_path) {
        matchedValue = payload.resume_path;
        action = "upload";
      } else {
        action = "skip";
      }
    } else {
      // Build candidate mapping pairs
      const candidates: { key: string; val: string }[] = [
        { key: "name", val: payload.user_profile.name },
        { key: "fullname", val: payload.user_profile.name },
        { key: "firstandlastname", val: payload.user_profile.name },
        { key: "email", val: payload.user_profile.email },
        { key: "phone", val: payload.user_profile.phone },
        { key: "linkedin", val: payload.user_profile.linkedin_url || "" },
        { key: "portfolio", val: payload.user_profile.portfolio_url || "" },
        { key: "website", val: payload.user_profile.portfolio_url || "" },
        { key: "whythisrole", val: payload.answers.why_role || "" },
        { key: "whyus", val: payload.answers.why_company || "" },
        { key: "experience", val: payload.answers.experience || "" },
        { key: "background", val: payload.answers.experience || "" },
        { key: "strength", val: payload.answers.strengths || "" },
        { key: "skill", val: payload.answers.strengths || "" }
      ];

      // Add custom answers to candidates
      const customKeys = Object.keys(payload.answers.custom || {});
      for (const k of customKeys) {
        candidates.push({ key: normalizeTitle(k), val: payload.answers.custom![k] });
      }

      let bestScore = 0;
      let bestValue = "";

      for (const cand of candidates) {
        // If exact subset match, boost it, else check similarity
        let score = computeSimilarity(normLabel, cand.key);
        // Boost score if the label literally contains the candidate key completely
        if (normLabel.includes(cand.key)) {
           score = Math.max(score, 0.85);
        }

        if (score > bestScore) {
          bestScore = score;
          bestValue = cand.val;
        }
      }

      if (bestScore >= THRESHOLD && bestValue) {
        matchedValue = bestValue;
      }
    }

    if (field.tagName === "select") {
      action = "select";
    }

    if (matchedValue) {
      mapped.push({ field, value: matchedValue, action });
    } else {
      mapped.push({ field, value: "", action: "skip" });
      if (field.required) {
        console.warn(`[FieldMapper] WARNING: Required field [${field.label || field.name}] was left unmapped.`);
      }
    }
  }

  return mapped;
}
