import { type FormField, type AnswerMap, type MappedField, type ConfidenceTier } from "./types.js";
import { logger } from "../browser/logger.js";

const KEYWORDS: Record<string, string[]> = {
  name: ["name", "full name", "legal name"],
  email: ["email", "email address", "contact email"],
  phone: ["phone", "mobile", "contact number"],
  linkedin: ["linkedin"],
  portfolio: ["portfolio", "website"],
  github: ["github"],
  experience: ["experience"],
};

export function mapFieldsToAnswers(fields: FormField[], answers: AnswerMap): MappedField[] {
  const mappedResults: MappedField[] = [];

  const normalizedAnswers = new Map<string, string>();
  for (const [key, value] of Object.entries(answers)) {
    normalizedAnswers.set(key.toLowerCase().trim(), value);
  }

  for (const field of fields) {
    const fieldLabel = field.label; // Label is already strongly normalized centrally
    let matchedValue: string | null = null;
    let confidence: ConfidenceTier = "none";

    // 1. Exact match inherently (High)
    if (normalizedAnswers.has(fieldLabel)) {
      matchedValue = normalizedAnswers.get(fieldLabel)!;
      confidence = "high";
    } 
    // 2. Includes match organically (Medium)
    else {
      for (const [key, val] of normalizedAnswers.entries()) {
        if (fieldLabel.includes(key) || key.includes(fieldLabel)) {
          matchedValue = val;
          confidence = "medium";
          break;
        }
      }
    }

    // 3. Keyword generic mapping implicitly (Low)
    if (!matchedValue) {
       for (const [key, aliases] of Object.entries(KEYWORDS)) {
          // Normalize keywords implicitly
          const matchFound = aliases.some(alias => fieldLabel.includes(alias.toLowerCase()));
          if (matchFound && normalizedAnswers.has(key)) {
             matchedValue = normalizedAnswers.get(key)!;
             confidence = "low";
             break;
          }
       }
    }

    if (matchedValue) {
      logger.info("field.mapped", { label: field.label, confidence });
    } else {
      if (field.required) {
        // Essential missing link. Natively track but do not arbitrarily inject trash implicitly.
        logger.warn("field.required_unmapped", { label: field.label });
      } else {
        logger.info("field.skipped", { label: field.label, reason: "Optional unmapped" });
      }
    }

    mappedResults.push({
      field,
      value: matchedValue,
      confidence
    });
  }

  return mappedResults;
}
