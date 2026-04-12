import { JobCard, type DashboardJob } from "./JobCard.js";
import { Button } from "./ui/button.js";
import { Card, CardContent } from "./ui/card.js";
import { Skeleton } from "./ui/skeleton.js";

interface JobListProps {
  jobs: DashboardJob[];
  isLoading?: boolean;
  onViewDetails?: (jobId: string) => void;
  onAddJob?: () => void;
}

function JobCardSkeleton() {
  return (
    <Card>
      <CardContent>
        <div className="space-y-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-2 w-full" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ onAddJob }: { onAddJob?: () => void }) {
  return (
    <Card className="border-dashed border-slate-300">
      <CardContent className="flex flex-col items-center justify-center gap-4 py-10 text-center">
        <div className="space-y-2">
          <p className="text-lg font-semibold text-slate-900">No jobs yet</p>
          <p className="text-sm text-slate-500">Add your first job URL to start tracking lifecycle and progress.</p>
        </div>
        <Button type="button" variant="default" onClick={onAddJob}>
          Add a job
        </Button>
      </CardContent>
    </Card>
  );
}

function AddJobCard({ onAddJob }: { onAddJob?: () => void }) {
  return (
    <Card className="h-full bg-emerald-100/80 p-2">
      <div className="flex h-full flex-col justify-between rounded-xl border border-white/60 bg-white/35 p-5">
        <div>
          <p className="text-sm text-slate-600">Quick Apply</p>
          <h3 className="mt-2 text-4xl leading-[1.05] font-medium text-slate-900">Add Your Own Link</h3>
        </div>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Paste a URL and optional job description.</p>
          <Button type="button" variant="default" onClick={onAddJob}>
            + Add
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function JobList({ jobs, isLoading = false, onViewDetails, onAddJob }: JobListProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        <JobCardSkeleton />
        <JobCardSkeleton />
        <JobCardSkeleton />
      </div>
    );
  }

  if (jobs.length === 0) {
    return <EmptyState onAddJob={onAddJob} />;
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
      <AddJobCard onAddJob={onAddJob} />
      {jobs.map((job) => (
        <JobCard key={job.jobId} job={job} onViewDetails={onViewDetails} />
      ))}
    </div>
  );
}

export type { DashboardJob };
