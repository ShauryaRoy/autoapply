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
};

function decisionTone(decision: Decision): "success" | "warning" | "danger" {
  if (decision === "APPLY") return "success";
  if (decision === "RISKY") return "warning";
  return "danger";
}

export function JobIntelligenceCard({
  title,
  company,
  matchScore,
  matchedSkills,
  missingSkills,
  decision
}: JobIntelligenceCardProps) {
  return (
    <Card>
      <CardHeader>
        <div>
          <p className="text-sm text-slate-500">Job Intelligence</p>
          <CardTitle className="mt-2 text-base">{title || "Awaiting role"}</CardTitle>
          <p className="mt-1 text-sm text-slate-500">{company || "Unknown company"}</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-slate-500">Match</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900">{matchScore}%</p>
          <Badge tone={decisionTone(decision)} className="mt-2">{decision}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="mb-2 text-sm text-slate-500">Skills matched</p>
          <div className="flex flex-wrap gap-2">
            {matchedSkills.length ? matchedSkills.map((skill) => <Badge key={skill} tone="success">{skill}</Badge>) : <p className="text-xs text-slate-500">No matched skills yet.</p>}
          </div>
        </div>
        <div>
          <p className="mb-2 text-sm text-slate-500">Missing skills</p>
          <div className="flex flex-wrap gap-2">
            {missingSkills.length ? missingSkills.map((skill) => <Badge key={skill} tone="warning">{skill}</Badge>) : <p className="text-xs text-slate-500">No major gaps detected.</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
