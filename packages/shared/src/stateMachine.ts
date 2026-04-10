import type { ApplicationState, ApplicationStep } from "./types.js";

export type OrchestratorEvent =
  | { type: "START" }
  | { type: "STEP_OK"; next: ApplicationStep }
  | { type: "STEP_FAIL"; error: string }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "RESET" };

const resumableSteps = new Set<ApplicationStep>([
  "queued",
  "job_scraped",
  "job_analyzed",
  "resume_optimized",
  "answers_generated",
  "browser_started",
  "logged_in",
  "form_filled",
  "submitted"
]);

export function applyEvent(state: ApplicationState, event: OrchestratorEvent): ApplicationState {
  if (event.type === "START" && state.step === "queued") {
    return { ...state, step: "job_scraped", lastError: undefined };
  }

  if (event.type === "STEP_OK") {
    return { ...state, step: event.next, lastError: undefined };
  }

  if (event.type === "STEP_FAIL") {
    const retries = state.retries + 1;
    if (retries < state.maxRetries) {
      return { ...state, retries, lastError: event.error };
    }
    return { ...state, retries, step: "failed", lastError: event.error };
  }

  if (event.type === "PAUSE") {
    return { ...state, step: "paused" };
  }

  if (event.type === "RESUME") {
    return resumableSteps.has(state.step) ? state : { ...state, step: "queued" };
  }

  if (event.type === "RESET") {
    return { ...state, step: "queued", retries: 0, lastError: undefined };
  }

  return state;
}
