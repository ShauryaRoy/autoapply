import { useMemo } from "react";

import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Input } from "../../components/ui/input.js";
import { getOnboardingPreview } from "../../hooks/useOnboardingStore.js";
import type { OnboardingStore } from "../../hooks/useOnboardingStore.js";

interface StepFirstApplyProps {
  store: Pick<OnboardingStore, "job" | "analyzeCurrentJob" | "applyFirstJob" | "setJobInput">;
  onSkip: () => void;
}

function decisionTone(decision: "APPLY" | "SKIP" | "RISKY"): "success" | "danger" | "warning" {
  if (decision === "APPLY") return "success";
  if (decision === "RISKY") return "warning";
  return "danger";
}

function formatTokenForDisplay(token: string): string {
  return token.replaceAll("_", " ");
}

export function StepFirstApply({ store, onSkip }: StepFirstApplyProps) {
  const analysis = store.job.analysis;
  const preview = useMemo(() => getOnboardingPreview({ job: store.job }), [store.job]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Launch Your First Apply</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-500">Paste a job URL or short description. We’ll analyze fit before applying.</p>
          <Input
            value={store.job.input}
            onChange={(event) => store.setJobInput(event.target.value)}
            placeholder="https://company.com/jobs/123 or role description"
          />

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="default" onClick={() => void store.analyzeCurrentJob()} disabled={store.job.isAnalyzing}>
              {store.job.isAnalyzing ? "Analyzing..." : "Analyze Job"}
            </Button>
            <Button
              type="button"
              variant="default"
              onClick={() => void store.applyFirstJob()}
              disabled={!analysis || store.job.isApplying}
            >
              {store.job.isApplying ? "Applying..." : "Apply"}
            </Button>
            <Button type="button" variant="ghost" onClick={onSkip}>
              Skip
            </Button>
          </div>

          {store.job.error ? <p className="text-sm text-rose-700">{store.job.error}</p> : null}
        </CardContent>
      </Card>

      {analysis ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Analysis Snapshot</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">Apply Score</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{Math.round(analysis.analysis.score)}%</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">Profile Fit</p>
                  <p className="mt-1 text-xl font-semibold text-slate-900">{Math.round(analysis.analysis.match_score)}%</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 col-span-2">
                  <p className="text-xs text-slate-500">Decision</p>
                  <Badge tone={decisionTone(analysis.analysis.decision)} className="mt-2">
                    {analysis.analysis.decision}
                  </Badge>
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm text-slate-500">Matched skills</p>
                <div className="flex flex-wrap gap-2">
                  {analysis.analysis.matched_skills.length ? (
                    analysis.analysis.matched_skills.map((skill) => (
                      <Badge key={skill} tone="success">
                        {formatTokenForDisplay(skill)}
                      </Badge>
                    ))
                  ) : (
                    <p className="text-sm text-slate-500">No matched skills reported.</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Resume Changes Preview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {preview.resumeChanges.map((line, index) => (
                <article key={`${line.before}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-rose-700">- {line.before}</p>
                  <p className="mt-1 text-xs text-emerald-700">+ {line.after}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {line.keywords.map((keyword) => (
                      <Badge key={`${index}-${keyword}`} tone="accent">
                        {keyword}
                      </Badge>
                    ))}
                  </div>
                </article>
              ))}
            </CardContent>
          </Card>

          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle>Generated Answers Preview</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {([
                ["summary", "Summary"],
                ["why_role", "Why role"],
                ["strengths", "Strengths"],
                ["experience", "Experience"]
              ] as const).map(([key, label]) => (
                <article key={key} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wider text-slate-500">{label}</p>
                  <p className="mt-1 text-sm text-slate-700">{preview.answers[key] || "No preview available."}</p>
                </article>
              ))}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
