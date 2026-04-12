import { useMemo, useState } from "react";

import { Button } from "./ui/button.js";
import { Badge } from "./ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";
import { Skeleton } from "./ui/skeleton.js";
import { useQueueJob } from "../hooks/useQueueJob.js";
import { JOB_STATUS, type JobStatus } from "../api/status.js";
import { navigateToJobDetail } from "../utils/dashboard-routes.js";

export interface DashboardJob {
  jobId: string;
  title: string;
  company: string;
  score?: number | null;
}

interface JobCardProps {
  job: DashboardJob;
  onViewDetails?: (jobId: string) => void;
}

function statusColorClass(status: JobStatus): string {
  switch (status) {
    case JOB_STATUS.PENDING:
      return "bg-slate-500";
    case JOB_STATUS.RUNNING:
      return "bg-sky-500";
    case JOB_STATUS.SUCCESS:
      return "bg-emerald-500";
    case JOB_STATUS.FAILED:
      return "bg-rose-500";
    case JOB_STATUS.PARTIAL_SUCCESS:
      return "bg-amber-500";
    case JOB_STATUS.CANCELLED:
      return "bg-slate-600";
    default:
      return "bg-slate-500";
  }
}

function cardTone(jobId: string): string {
  const tones = [
    "bg-emerald-100",
    "bg-amber-100",
    "bg-yellow-100",
    "bg-rose-100"
  ];
  const hash = Array.from(jobId).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return tones[hash % tones.length] ?? "bg-slate-100";
}

function jobTags(title: string): string[] {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);

  const deduped: string[] = [];
  for (const word of words) {
    if (!deduped.includes(word)) deduped.push(word);
    if (deduped.length >= 3) break;
  }

  return deduped.length ? deduped : ["job", "application"];
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

function isCancellable(status: JobStatus): boolean {
  return status === JOB_STATUS.PENDING || status === JOB_STATUS.RUNNING;
}

function formatPercent(progress: number): string {
  return `${Math.round(progress)}%`;
}

export function JobCard({ job, onViewDetails }: JobCardProps) {
  const { data, status, progress, errors, isLoading, cancel, error } = useQueueJob(job.jobId);
  const [isCancelling, setIsCancelling] = useState(false);

  const score = useMemo(() => {
    if (typeof job.score === "number") return job.score;
    const result = data?.result;
    if (!result || typeof result !== "object") return null;

    const resultRecord = result as Record<string, unknown>;
    const directScore = resultRecord.score;
    if (typeof directScore === "number") return directScore;

    const matchScore = resultRecord.match_score;
    if (typeof matchScore === "number") return matchScore;

    return null;
  }, [data?.result, job.score]);

  const handleCancel = async () => {
    if (!isCancellable(status) || isCancelling) return;
    try {
      setIsCancelling(true);
      await cancel();
    } finally {
      setIsCancelling(false);
    }
  };

  const badge = statusBadge(status);
  const tags = useMemo(() => jobTags(job.title), [job.title]);
  const backgroundTone = useMemo(() => cardTone(job.jobId), [job.jobId]);
  const handleViewDetails = () => {
    if (onViewDetails) {
      onViewDetails(job.jobId);
      return;
    }
    navigateToJobDetail(job.jobId);
  };

  return (
    <Card className={`h-full p-2 ${backgroundTone}`}>
      <div className="h-full rounded-xl border border-white/60 bg-white/45 p-4 backdrop-blur-sm">
        <CardHeader className="mb-3">
          <div className="space-y-1">
            {isLoading ? <Skeleton className="h-4 w-32" /> : <p className="text-sm text-slate-600">{job.company}</p>}
            {isLoading ? <Skeleton className="h-8 w-44" /> : <CardTitle className="text-[2rem] leading-[1.05] font-medium text-slate-900">{job.title}</CardTitle>}
          </div>
          <div className="text-right">
            {isLoading ? <Skeleton className="h-10 w-10 rounded-full" /> : <p className="text-xl font-semibold text-slate-900">{typeof score === "number" ? `${Math.round(score)}%` : "--"}</p>}
            <p className="text-xs text-slate-600">match</p>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <span key={tag} className="rounded-full bg-black/10 px-3 py-1 text-xs text-slate-700">
                {tag}
              </span>
            ))}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>{status}</span>
              <span>{formatPercent(progress)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/70">
              <div
                className={`h-full rounded-full transition-all duration-500 ease-out ${statusColorClass(status)}`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-600">
            <Badge tone={badge.tone} className={badge.className}>{status}</Badge>
            <span>{errors.length} errors</span>
          </div>

          {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error.message}</p> : null}

          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="flex-1"
              onClick={handleViewDetails}
            >
              Details
            </Button>
            <Button
              type="button"
              size="sm"
              variant="default"
              className="flex-1"
              disabled={!isCancellable(status) || isCancelling}
              onClick={() => {
                void handleCancel();
              }}
            >
              {isCancelling ? "Stopping..." : "Apply"}
            </Button>
          </div>
        </CardContent>
      </div>
    </Card>
  );
}
