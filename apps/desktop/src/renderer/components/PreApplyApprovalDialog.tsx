import { useMemo, useState } from "react";

import { addJobToQueue } from "../api/queue.js";
import type { QueueAddRequest, QueueAddResponse } from "../api/contracts.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Dialog } from "./ui/dialog.js";

export type ApprovalDecision = "APPLY" | "SKIP" | "RISKY";

export interface ApprovalResumeDiffLine {
  before: string;
  after: string;
  keywords?: string[];
}

export interface ApprovalDraft {
  payload: QueueAddRequest;
  title?: string;
  company?: string;
  score?: number | null;
  decision?: ApprovalDecision;
  resumeDiff?: ApprovalResumeDiffLine[];
  answers?: Partial<Record<"summary" | "why_role" | "strengths" | "experience", string>>;
  missingSkillsCount?: number;
}

interface PreApplyApprovalDialogProps {
  open: boolean;
  draft: ApprovalDraft;
  onOpenChange: (open: boolean) => void;
  onApproved?: (response: QueueAddResponse) => void;
  onRejected?: () => void;
}

function confidence(score: number | null, missingSkillsCount: number) {
  if (score !== null && score >= 80 && missingSkillsCount <= 2) {
    return { level: "High", label: "SAFE", tone: "success" as const };
  }
  if (score !== null && score >= 60) {
    return { level: "Medium", label: "RISKY", tone: "warning" as const };
  }
  return { level: "Low", label: "RISKY", tone: "danger" as const };
}

export function PreApplyApprovalDialog({ open, draft, onOpenChange, onApproved, onRejected }: PreApplyApprovalDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const score = typeof draft.score === "number" ? Math.max(0, Math.min(100, Math.round(draft.score))) : null;
  const missingSkillsCount = draft.missingSkillsCount ?? 0;
  const confidenceState = confidence(score, missingSkillsCount);

  const showSafetyWarning = useMemo(
    () => (score !== null && score < 60) || missingSkillsCount >= 5,
    [missingSkillsCount, score]
  );

  const handleApprove = async () => {
    if (isSubmitting) return;
    try {
      setIsSubmitting(true);
      setSubmitError(null);
      const response = await addJobToQueue(draft.payload);
      onApproved?.(response);
      onOpenChange(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to queue job");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReject = () => {
    if (isSubmitting) return;
    onRejected?.();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Review Before Queueing"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={handleReject} disabled={isSubmitting}>
            Reject
          </Button>
          <Button type="button" variant="default" onClick={() => void handleApprove()} disabled={isSubmitting}>
            {isSubmitting ? "Approving..." : "Approve & Queue"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm text-slate-500">Job</p>
          <p className="mt-2 text-sm font-semibold text-slate-900">{draft.title ?? draft.payload.job_id}</p>
          <p className="text-xs text-slate-500">{draft.company ?? "Unknown company"}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge tone={confidenceState.tone}>{confidenceState.level} Confidence</Badge>
            <Badge tone={confidenceState.tone}>{confidenceState.label}</Badge>
            <Badge tone={draft.decision === "APPLY" ? "success" : draft.decision === "RISKY" ? "warning" : "danger"}>
              {draft.decision ?? "UNKNOWN"}
            </Badge>
          </div>

          <p className="mt-2 text-sm text-slate-700">Confidence score: {score === null ? "--" : `${score}%`}</p>

          {showSafetyWarning ? (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              This job has low match score. Applying may reduce response rate.
            </p>
          ) : null}
        </section>

        <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm text-slate-500">Generated Answers Preview</p>
          <div className="mt-2 space-y-2">
            {([
              ["summary", "Summary"],
              ["why_role", "Why role"],
              ["strengths", "Strengths"],
              ["experience", "Experience"]
            ] as const).map(([key, label]) => (
              <article key={key} className="rounded-lg border border-slate-200 bg-white p-2.5">
                <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
                <p className="mt-1 line-clamp-2 text-xs text-slate-700">{draft.answers?.[key] ?? "No preview"}</p>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <p className="mb-2 text-sm text-slate-500">Resume Changes Preview</p>
        <div className="space-y-2">
          {(draft.resumeDiff ?? []).slice(0, 3).map((line, idx) => (
            <article key={`${line.before}-${idx}`} className="rounded-lg border border-slate-200 bg-white p-2.5">
              <p className="text-xs text-rose-700">- {line.before}</p>
              <p className="mt-1 text-xs text-emerald-700">+ {line.after}</p>
              {line.keywords?.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {line.keywords.map((keyword) => (
                    <Badge key={`${idx}-${keyword}`} tone="accent">{keyword}</Badge>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
          {!(draft.resumeDiff?.length) ? <p className="text-xs text-slate-500">No resume changes preview available.</p> : null}
        </div>
      </section>

      {submitError ? <p className="text-xs text-rose-700">{submitError}</p> : null}
    </Dialog>
  );
}
