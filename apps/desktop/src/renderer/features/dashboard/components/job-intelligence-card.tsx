import { Badge } from "../../../components/ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import type { Decision } from "../types.js";

type JobIntelligenceCardProps = {
  title: string;
  company: string;
  matchScore: number;
  matchedSkills: string[];
  missingSkills: string[];
  decision: Decision;
  scoring?: {
    score: number;
    decision: "auto_apply" | "review" | "skip";
    reasons: string[];
  };
};

function decisionTone(decision: Decision): "success" | "warning" | "danger" {
  if (decision === "APPLY") return "success";
  if (decision === "RISKY") return "warning";
  return "danger";
}

function formatTokenForDisplay(token: string): string {
  return token.replaceAll("_", " ");
}

export function JobIntelligenceCard({
  title,
  company,
  matchScore,
  matchedSkills,
  missingSkills,
  decision,
  scoring
}: JobIntelligenceCardProps) {
  const applyScore = scoring ? Math.round(scoring.score * 100) : null;
  const showReevaluationFlag = applyScore !== null && Math.abs(matchScore - applyScore) > 25;

  return (
    <Card>
      <CardHeader>
        <div>
          <p className="text-sm text-slate-500">Job Intelligence</p>
          <CardTitle className="mt-2 text-base">{title || "Awaiting role"}</CardTitle>
          <p className="mt-1 text-sm text-slate-500">{company || "Unknown company"}</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-slate-500">Profile Fit</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">{matchScore}%</p>
          <Badge tone={decisionTone(decision)} className="mt-2">{decision}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {scoring ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs text-slate-500">Job Scoring</p>
            <p className="mt-1 text-sm font-medium text-slate-900">Apply Score: {(scoring.score * 100).toFixed(0)}%</p>
            <p className="text-sm text-slate-700">Decision: {scoring.decision}</p>
            {showReevaluationFlag ? (
              <p className="mt-1 text-xs font-medium text-amber-700">Re-evaluated after deep analysis</p>
            ) : null}
            <div className="mt-2 space-y-1">
              {scoring.reasons.map((reason) => (
                <p key={reason} className="text-xs text-slate-600">- {formatTokenForDisplay(reason)}</p>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-sm text-slate-500">Skills matched</p>
          <div className="flex flex-wrap gap-2">
            {matchedSkills.length ? matchedSkills.map((skill) => <Badge key={skill} tone="success">{formatTokenForDisplay(skill)}</Badge>) : <p className="text-xs text-slate-500">No matched skills yet.</p>}
          </div>
        </div>
        <div>
          <p className="mb-2 text-sm text-slate-500">Missing skills</p>
          <div className="flex flex-wrap gap-2">
            {missingSkills.length ? missingSkills.map((skill) => <Badge key={skill} tone="warning">{formatTokenForDisplay(skill)}</Badge>) : <p className="text-xs text-slate-500">No major gaps detected.</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
