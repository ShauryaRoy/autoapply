import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Dialog } from "../../../components/ui/dialog.js";
import type { ResumeDiffLine } from "../types.js";

type ApprovalModalProps = {
  open: boolean;
  score: number;
  generatedAnswers: Array<{ prompt: string; answer: string }>;
  resumeDiff: ResumeDiffLine[];
  onApprove: () => void;
  onEdit: () => void;
  onReject: () => void;
  onOpenChange: (open: boolean) => void;
};

export function ApprovalModal({
  open,
  score,
  generatedAnswers,
  resumeDiff,
  onApprove,
  onEdit,
  onReject,
  onOpenChange
}: ApprovalModalProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Final Approval Before Apply"
      footer={
        <>
          <Button variant="ghost" onClick={onEdit}>Edit</Button>
          <Button variant="danger" onClick={onReject}>Reject</Button>
          <Button variant="default" onClick={onApprove}>Approve & Apply</Button>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm text-slate-500">Job Score</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">{score}%</p>
          <Badge tone={score >= 80 ? "success" : score >= 60 ? "warning" : "danger"} className="mt-2">
            {score >= 80 ? "Strong Fit" : score >= 60 ? "Needs Review" : "Low Fit"}
          </Badge>
        </section>

        <section className="rounded-xl border border-slate-200 bg-slate-50 p-3 lg:col-span-2">
          <p className="text-sm text-slate-500">Resume Changes</p>
          <ul className="mt-2 space-y-2 text-xs text-slate-600">
            {resumeDiff.slice(0, 3).map((line, idx) => (
              <li key={`${line.before}-${idx}`} className="rounded-lg border border-slate-200 bg-white p-2">
                <p className="text-rose-700">- {line.before}</p>
                <p className="mt-1 text-emerald-700">+ {line.after}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <p className="mb-2 text-sm text-slate-500">Generated Answers Preview</p>
        <div className="space-y-2">
          {generatedAnswers.map((answer) => (
            <div key={answer.prompt} className="rounded-lg border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-500">{answer.prompt}</p>
              <p className="mt-1 text-sm text-slate-700">{answer.answer}</p>
            </div>
          ))}
        </div>
      </section>
    </Dialog>
  );
}
