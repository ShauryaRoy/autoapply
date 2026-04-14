import { useEffect, useMemo, useState } from "react";

import { getJobDetails } from "../api/job.js";
import { addJobToQueue } from "../api/queue.js";
import { JOB_STATUS, type JobStatus } from "../api/status.js";
import type { JobAnalysisDetailsResponse, QueueAddRequest, QueueStatusResponse } from "../api/contracts.js";
import { useQueueJob } from "../hooks/useQueueJob.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Skeleton } from "../components/ui/skeleton.js";

type DetailTab = "overview" | "resume" | "answers" | "logs";

type ResumeDiffLine = {
  before: string;
  after: string;
  keywords: string[];
};

type ConfidenceState = {
  level: "High" | "Medium" | "Low";
  label: "SAFE" | "RISKY";
  tone: "success" | "warning" | "danger";
};

interface JobDetailProps {
  jobId: string;
  jobTitle?: string;
  company?: string;
  onBack?: () => void;
}

function statusBadge(status: JobStatus): { tone: "neutral" | "accent" | "success" | "danger" | "warning"; className?: string } {
  switch (status) {
    case JOB_STATUS.PENDING:
      return { tone: "neutral" };
    case JOB_STATUS.RUNNING:
      return { tone: "accent" };
    case JOB_STATUS.SUCCESS:
      return { tone: "success" };
    case JOB_STATUS.FAILED:
      return { tone: "danger" };
    case JOB_STATUS.PARTIAL_SUCCESS:
      return { tone: "warning" };
    case JOB_STATUS.CANCELLED:
      return { tone: "neutral", className: "opacity-70" };
    default:
      return { tone: "neutral" };
  }
}

function progressColor(status: JobStatus): string {
  switch (status) {
    case JOB_STATUS.SUCCESS:
      return "bg-emerald-500";
    case JOB_STATUS.FAILED:
      return "bg-rose-500";
    case JOB_STATUS.PARTIAL_SUCCESS:
      return "bg-amber-500";
    case JOB_STATUS.CANCELLED:
      return "bg-slate-600";
    case JOB_STATUS.RUNNING:
      return "bg-sky-500";
    default:
      return "bg-slate-500";
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function readDecision(result: Record<string, unknown>): "APPLY" | "SKIP" | "RISKY" | "UNKNOWN" {
  const analysis = readRecord(result.analysis);
  const candidate = analysis.decision ?? result.decision;
  if (candidate === "APPLY" || candidate === "SKIP" || candidate === "RISKY") return candidate;
  return "UNKNOWN";
}

function readScore(result: Record<string, unknown>): number | null {
  const analysis = readRecord(result.analysis);
  const candidates = [analysis.score, analysis.match_score, result.score, result.match_score];
  const found = candidates.find((entry) => typeof entry === "number");
  return typeof found === "number" ? found : null;
}

function readResumeDiff(result: Record<string, unknown>): ResumeDiffLine[] {
  const candidates = [
    result.resume_diff,
    result.resumeDiff,
    result.resume_changes,
    result.resumeChanges,
    result.resume_diff_lines
  ];

  const raw = candidates.find((entry) => Array.isArray(entry));
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry): ResumeDiffLine | null => {
      const record = readRecord(entry);
      const before = typeof record.before === "string" ? record.before : "";
      const after = typeof record.after === "string" ? record.after : "";
      const keywords = readStringArray(record.injectedKeywords ?? record.keywords_added ?? record.keywords);
      if (!before && !after) return null;
      return { before, after, keywords };
    })
    .filter((entry): entry is ResumeDiffLine => !!entry);
}

function readAnswers(result: Record<string, unknown>): Record<string, string> {
  const answersRecord = readRecord(result.answers ?? result.generated_answers ?? result.generatedAnswers);
  const fields = ["summary", "why_role", "strengths", "experience"] as const;

  return fields.reduce<Record<string, string>>((acc, field) => {
    const value = answersRecord[field];
    acc[field] = typeof value === "string" ? value : "";
    return acc;
  }, {});
}

function confidence(score: number | null, missingSkillsCount: number): ConfidenceState {
  if (score !== null && score >= 80 && missingSkillsCount <= 2) {
    return { level: "High", label: "SAFE", tone: "success" };
  }
  if (score !== null && score >= 60) {
    return { level: "Medium", label: "RISKY", tone: "warning" };
  }
  return { level: "Low", label: "RISKY", tone: "danger" };
}

function formatTokenForDisplay(token: string): string {
  return token.replaceAll("_", " ");
}

function getFailedStep(timeline: Array<{ label: string; status: "pending" | "running" | "completed" | "failed" }>): string {
  const failed = timeline.find((step) => step.status === "failed");
  return failed?.label ?? "Unknown step";
}

function buildRetryPayload(jobId: string, result: Record<string, unknown>): QueueAddRequest | null {
  const retryPayload = readRecord(result.retry_payload ?? result.retryPayload);
  const source = Object.keys(retryPayload).length ? retryPayload : result;

  const jobUrl = source.job_url ?? source.jobUrl ?? source.url;
  const userProfile = source.user_profile ?? source.userProfile ?? source.profile;
  const resume = source.resume ?? source.resume_data ?? source.resumeData;
  const resumePath = source.resume_path ?? source.resumePath;

  if (typeof jobUrl !== "string" || !jobUrl.trim()) {
    return null;
  }

  return {
    job_id: jobId,
    job_url: jobUrl,
    user_profile: userProfile && typeof userProfile === "object" ? (userProfile as Record<string, unknown>) : {},
    resume: resume && typeof resume === "object" ? (resume as Record<string, unknown>) : {},
    resume_path: typeof resumePath === "string" && resumePath.trim() ? resumePath : undefined
  };
}

function formatLog(log: unknown): string {
  if (typeof log === "string") return log;
  if (log && typeof log === "object") {
    const record = log as Record<string, unknown>;
    const message = record.message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(record);
    } catch {
      return "[log entry]";
    }
  }
  return String(log);
}

function extractTimestamp(value: unknown): string | null {
  const record = readRecord(value);
  const candidate = record.timestamp ?? record.completedAt ?? record.createdAt;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

function buildTimeline(steps: QueueStatusResponse["steps"], logs: unknown[], status: JobStatus) {
  const order: Array<{ id: keyof QueueStatusResponse["steps"]; label: string; keyword: string }> = [
    { id: "analyze", label: "Analyze", keyword: "analy" },
    { id: "patched_resume", label: "Patch", keyword: "patch" },
    { id: "answers", label: "Generate", keyword: "answer" },
    { id: "apply", label: "Apply", keyword: "apply" }
  ];

  const completionByStep = order.map((step) => Boolean(steps[step.id]));
  const activeIndex = completionByStep.findIndex((done) => !done);

  return order.map((step, index) => {
    const stepPayload = steps[step.id];
    const stepLogs = logs
      .map(formatLog)
      .filter((entry) => entry.toLowerCase().includes(step.keyword));

    let stepStatus: "pending" | "running" | "completed" | "failed" = "pending";
    if (stepPayload) {
      stepStatus = "completed";
    } else if (status === JOB_STATUS.FAILED && (activeIndex === -1 || index === activeIndex)) {
      stepStatus = "failed";
    } else if (status === JOB_STATUS.RUNNING && (activeIndex === -1 ? index === order.length - 1 : index === activeIndex)) {
      stepStatus = "running";
    }

    return {
      id: step.id,
      label: step.label,
      status: stepStatus,
      timestamp: extractTimestamp(stepPayload),
      logs: stepLogs
    };
  });
}

function StepBadge({ status }: { status: "pending" | "running" | "completed" | "failed" }) {
  if (status === "completed") return <Badge tone="success">COMPLETED</Badge>;
  if (status === "running") return <Badge tone="accent">RUNNING</Badge>;
  if (status === "failed") return <Badge tone="danger">FAILED</Badge>;
  return <Badge tone="neutral">PENDING</Badge>;
}

export function JobDetail({ jobId, jobTitle, company, onBack }: JobDetailProps) {
  const {
    data,
    status,
    progress,
    steps,
    logs,
    errors,
    isLoading,
    isPolling,
    error,
    refetch,
    cancel
  } = useQueueJob(jobId);

  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [analysisDetails, setAnalysisDetails] = useState<JobAnalysisDetailsResponse | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    const run = async () => {
      try {
        const response = await getJobDetails(jobId);
        if (ignore) return;
        setAnalysisDetails(response);
        setAnalysisError(null);
      } catch (caughtError) {
        if (ignore) return;
        const message = caughtError instanceof Error ? caughtError.message : "Unable to load job details";
        setAnalysisError(message);
      }
    };

    void run();

    return () => {
      ignore = true;
    };
  }, [jobId]);

  const result = useMemo(() => readRecord(data?.result), [data?.result]);
  const score = useMemo(() => readScore(result), [result]);
  const decision = useMemo(() => readDecision(result), [result]);
  const matchedSkills = useMemo(() => readStringArray(readRecord(result.analysis).matched_skills ?? result.matched_skills), [result]);
  const missingSkills = useMemo(() => readStringArray(readRecord(result.analysis).missing_skills ?? result.missing_skills), [result]);
  const riskFlags = useMemo(() => readStringArray(readRecord(result.analysis).risk_flags ?? result.risk_flags), [result]);
  const resumeDiff = useMemo(() => readResumeDiff(result), [result]);
  const answers = useMemo(() => readAnswers(result), [result]);
  const timeline = useMemo(() => buildTimeline(steps, logs, status), [logs, status, steps]);
  const missingSkillsCount = missingSkills.length;
  const confidenceState = useMemo(() => confidence(score, missingSkillsCount), [missingSkillsCount, score]);
  const showSafetyWarning = useMemo(
    () => (score !== null && score < 60) || missingSkillsCount >= 5,
    [missingSkillsCount, score]
  );
  const statusFeedback = useMemo(() => {
    if (status === JOB_STATUS.RUNNING) return "Applying...";
    if (status === JOB_STATUS.SUCCESS) return "Completed";
    if (status === JOB_STATUS.FAILED) return `Failed at: ${getFailedStep(timeline)}`;
    if (status === JOB_STATUS.PARTIAL_SUCCESS) return "Partially completed";
    if (status === JOB_STATUS.CANCELLED) return "Cancelled";
    return "Queued";
  }, [status, timeline]);

  const headerTitle = jobTitle ?? analysisDetails?.summary ?? `Job ${jobId}`;
  const headerCompany = company ?? "Unknown company";
  const badge = statusBadge(status);
  const canCancel = status === JOB_STATUS.PENDING || status === JOB_STATUS.RUNNING;
  const canRetry = status === JOB_STATUS.FAILED || status === JOB_STATUS.PARTIAL_SUCCESS;
  const answersText = useMemo(() => {
    return [
      `Summary: ${answers.summary || ""}`,
      `Why role: ${answers.why_role || ""}`,
      `Strengths: ${answers.strengths || ""}`,
      `Experience: ${answers.experience || ""}`
    ].join("\n\n");
  }, [answers]);

  const handleCancel = async () => {
    if (isCancelling || !canCancel) return;
    const shouldCancel = window.confirm("Cancel this job? The current automation run will stop.");
    if (!shouldCancel) return;
    try {
      setIsCancelling(true);
      await cancel();
    } finally {
      setIsCancelling(false);
    }
  };

  const handleRetry = async () => {
    if (isRetrying || !canRetry) return;
    const payload = buildRetryPayload(jobId, result);
    if (!payload) {
      setRetryMessage("Retry is unavailable because required queue payload is missing.");
      return;
    }

    try {
      setIsRetrying(true);
      setRetryMessage(null);
      await addJobToQueue(payload);
      setRetryMessage("Job has been re-added to the queue.");
      await refetch();
    } catch (caughtError) {
      setRetryMessage(caughtError instanceof Error ? caughtError.message : "Retry failed");
    } finally {
      setIsRetrying(false);
    }
  };

  const handleCopyAnswers = async () => {
    try {
      await navigator.clipboard.writeText(answersText);
      setRetryMessage("Answers copied to clipboard.");
    } catch {
      setRetryMessage("Unable to copy answers in this environment.");
    }
  };

  return (
    <section className="space-y-4">
      <Card>
        <CardHeader className="flex-wrap items-start gap-3">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={onBack}>
                Back
              </Button>
              <p className="text-xs text-slate-500">{jobId}</p>
            </div>
            {isLoading ? <Skeleton className="h-6 w-64" /> : <CardTitle className="text-xl">{headerTitle}</CardTitle>}
            <p className="text-sm text-slate-500">{headerCompany}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={badge.tone} className={badge.className}>
              {status}
            </Badge>
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={!canCancel || isCancelling}
              onClick={() => {
                void handleCancel();
              }}
            >
              {isCancelling ? "Cancelling..." : "Cancel"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{isPolling ? "Live polling" : "Polling stopped"}</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-200">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${progressColor(status)}`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs font-medium text-slate-700">{statusFeedback}</p>
          {status === JOB_STATUS.FAILED ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              <p className="font-medium">Execution failed</p>
              <p className="mt-1">{errors[0] ?? "An unknown error occurred while processing this job."}</p>
              <div className="mt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void refetch();
                  }}
                >
                  Retry status fetch
                </Button>
              </div>
            </div>
          ) : null}
          {error ? <p className="text-xs text-rose-600">{error.message}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={!canCancel || isCancelling}
              onClick={() => {
                void handleCancel();
              }}
            >
              {isCancelling ? "Cancelling..." : "Cancel"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={!canRetry || isRetrying}
              onClick={() => {
                void handleRetry();
              }}
            >
              {isRetrying ? "Retrying..." : "Retry Job"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void handleCopyAnswers()}>
              Copy answers
            </Button>
          </div>
          {retryMessage ? <p className="text-xs text-slate-300">{retryMessage}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <div className="flex flex-wrap gap-2">
            {(["overview", "resume", "answers", "logs"] as const).map((tab) => (
              <Button
                key={tab}
                type="button"
                size="sm"
                variant={activeTab === tab ? "default" : "ghost"}
                onClick={() => setActiveTab(tab)}
              >
                {tab === "overview" ? "Overview" : tab === "resume" ? "Resume" : tab === "answers" ? "Answers" : "Logs"}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {activeTab === "overview" ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Job Intelligence</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">Score</p>
                  <p className="mt-1 text-xl font-semibold text-slate-900">{score === null ? "--" : Math.round(score)}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">Decision</p>
                  <p className="mt-1 text-xl font-semibold text-slate-900">{decision}</p>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs text-slate-500">Confidence</p>
                <div className="mt-2 flex items-center gap-2">
                  <p className="text-xl font-semibold text-slate-900">{score === null ? "--" : `${Math.round(score)}%`}</p>
                  <Badge tone={confidenceState.tone}>{confidenceState.level}</Badge>
                  <Badge tone={confidenceState.tone}>{confidenceState.label}</Badge>
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm text-slate-500">Matched skills</p>
                <div className="flex flex-wrap gap-2">
                  {matchedSkills.length ? matchedSkills.map((skill) => <Badge key={skill} tone="success">{formatTokenForDisplay(skill)}</Badge>) : <p className="text-sm text-slate-500">No matched skills yet.</p>}
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm text-slate-500">Missing skills</p>
                <div className="flex flex-wrap gap-2">
                  {missingSkills.length ? missingSkills.map((skill) => <Badge key={skill} tone="warning">{formatTokenForDisplay(skill)}</Badge>) : <p className="text-sm text-slate-500">No missing skills reported.</p>}
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm text-slate-500">Risk flags</p>
                <div className="flex flex-wrap gap-2">
                  {riskFlags.length ? riskFlags.map((flag) => <Badge key={flag} tone="danger">{flag}</Badge>) : <p className="text-sm text-slate-500">No risk flags detected.</p>}
                </div>
              </div>
              {showSafetyWarning ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  This job has low match score. Applying may reduce response rate.
                </p>
              ) : null}
              {analysisError ? <p className="text-xs text-amber-700">Details note: {analysisError}</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Execution Timeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {timeline.map((item) => (
                <article key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-slate-900">{item.label}</p>
                    <StepBadge status={item.status} />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{item.timestamp ?? "No timestamp yet"}</p>
                  {item.logs.length ? <p className="mt-2 text-xs text-slate-700">{item.logs[0]}</p> : null}
                </article>
              ))}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {activeTab === "resume" ? (
        <Card>
          <CardHeader>
            <CardTitle>Resume Changes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {resumeDiff.length ? (
              resumeDiff.map((line, idx) => (
                <article key={`${line.before}-${idx}`} className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-2">
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                    <p className="text-xs uppercase tracking-wider text-rose-700">Original bullet</p>
                    <p className="mt-2 text-sm text-slate-700">{line.before || "--"}</p>
                  </div>
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                    <p className="text-xs uppercase tracking-wider text-emerald-700">Updated bullet</p>
                    <p className="mt-2 text-sm text-slate-900">{line.after || "--"}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {line.keywords.map((keyword) => (
                        <Badge key={keyword} tone="accent">
                          {keyword}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </article>
              ))
            ) : (
              <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                Resume diff is not available for this job yet.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {activeTab === "answers" ? (
        <Card>
          <CardHeader>
            <CardTitle>Generated Answers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {([
              ["summary", "Summary"],
              ["why_role", "Why role"],
              ["strengths", "Strengths"],
              ["experience", "Experience"]
            ] as const).map(([key, label]) => (
              <article key={key} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wider text-slate-500">{label}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{answers[key] || "No generated answer yet."}</p>
              </article>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {activeTab === "logs" ? (
        <Card>
          <CardHeader>
            <CardTitle>Execution Logs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!logs.length ? (
              <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                No logs available yet.
              </p>
            ) : (
              <details open className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <summary className="cursor-pointer select-none text-sm font-medium text-slate-700">Raw logs ({logs.length})</summary>
                <div className="mt-3 max-h-[360px] space-y-2 overflow-auto pr-1">
                  {logs.map((log, index) => (
                    <pre
                      key={`${index}-${formatLog(log).slice(0, 16)}`}
                      className="whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-700"
                    >
                      {formatLog(log)}
                    </pre>
                  ))}
                </div>
              </details>
            )}
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
