import { type MappedField, type FormField } from "../form/types.js";
import { logger } from "../browser/logger.js";

export type ApplyMode = "assist" | "smart_auto" | "full_auto";

export type ApplyConfig = {
  mode: ApplyMode;
  autoSubmit: boolean;
  pauseOnLowConfidence: boolean;
  pauseOnLongAnswers: boolean;
};

export function shouldAutoApply(input: {
  mappedFields: MappedField[];
  requiredUnmapped: FormField[];
  config: ApplyConfig;
}): "auto" | "review" {
  const { mappedFields, requiredUnmapped, config } = input;

  const mappedCount = mappedFields.filter((field) => !!field.value).length;
  const total = mappedFields.length;
  const coverage = total > 0 ? mappedCount / total : 0;
  if (coverage < 0.6) {
    logger.warn("auto.coverage_low", { coverage });
    return "review";
  }

  if (requiredUnmapped.length > 0) return "review";

  const lowConfidence = mappedFields.some((field) => field.confidence === "low");
  if (lowConfidence && config.pauseOnLowConfidence) return "review";

  const mediumCount = mappedFields.filter((field) => field.confidence === "medium").length;
  if (mediumCount > 3 && config.pauseOnLowConfidence) {
    logger.warn("auto.medium_confidence_threshold", { mediumCount });
    return "review";
  }

  const longAnswer = mappedFields.some(
    (field) => field.field.type === "textarea" && field.value && field.value.length > 200
  );
  if (longAnswer && config.pauseOnLongAnswers) {
    logger.warn("auto.long_answer_detected");
    return "review";
  }

  return "auto";
}
