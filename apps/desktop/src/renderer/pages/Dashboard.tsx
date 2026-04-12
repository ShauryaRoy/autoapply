import { useEffect, useMemo, useState, type ReactNode } from "react";

import { JobList, type DashboardJob } from "../components/JobList.js";
import { Input } from "../components/ui/input.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { DashboardLayout } from "../layouts/dashboard-layout.js";
import { JobDetail } from "./JobDetail.js";
import { PreApplyApprovalDialog, type ApprovalDraft } from "../components/PreApplyApprovalDialog.js";
import type { QueueAddResponse } from "../api/contracts.js";
import { OnboardingLayout } from "./onboarding/OnboardingLayout.js";
import {
  getDashboardRoute,
  navigateToDashboardList,
  navigateToJobDetail,
  type DashboardRoute
} from "../utils/dashboard-routes.js";

interface DashboardProps {
  sidebar: ReactNode;
  jobs: DashboardJob[];
  isLoadingJobs?: boolean;
  onViewDetails?: (jobId: string) => void;
  onAddJob?: () => void;
  approvalDraft?: ApprovalDraft | null;
  onApprovalAccepted?: (response: QueueAddResponse) => void;
  onApprovalRejected?: () => void;
}

export function Dashboard({
  sidebar,
  jobs,
  isLoadingJobs = false,
  onViewDetails,
  onAddJob,
  approvalDraft,
  onApprovalAccepted,
  onApprovalRejected
}: DashboardProps) {
  const [route, setRoute] = useState<DashboardRoute>(() => getDashboardRoute(window.location.pathname));
  const [approvalOpen, setApprovalOpen] = useState(Boolean(approvalDraft));
  const [onboardingSuccess, setOnboardingSuccess] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setApprovalOpen(Boolean(approvalDraft));
  }, [approvalDraft]);

  useEffect(() => {
    const message = localStorage.getItem("autoapply_onboarding_success_message");
    if (!message) return;
    setOnboardingSuccess(message);
    localStorage.removeItem("autoapply_onboarding_success_message");
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(getDashboardRoute(window.location.pathname));
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  const activeJob = useMemo(() => {
    if (route.kind !== "detail") return null;
    return jobs.find((job) => job.jobId === route.jobId) ?? null;
  }, [jobs, route]);

  const filteredJobs = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return jobs;
    return jobs.filter((job) => {
      return job.title.toLowerCase().includes(query) || job.company.toLowerCase().includes(query);
    });
  }, [jobs, search]);

  const handleViewDetails = (jobId: string) => {
    if (onViewDetails) {
      onViewDetails(jobId);
      return;
    }
    navigateToJobDetail(jobId);
  };

  return (
    <>
      <DashboardLayout
        sidebar={sidebar}
        leftRail={
          <Card className="p-5">
            <CardHeader>
              <CardTitle className="text-lg">Dashboard</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-600">
              <p>Browse and manage your job cards from one clean board.</p>
              <p className="text-slate-500">Use search to quickly find roles by title or company.</p>
              <Button type="button" variant="default" className="w-full" onClick={onAddJob}>
                Add Job Link
              </Button>
            </CardContent>
          </Card>
        }
        main={
          route.kind === "onboarding" ? (
            <OnboardingLayout />
          ) : route.kind === "detail" ? (
            <JobDetail
              jobId={route.jobId}
              jobTitle={activeJob?.title}
              company={activeJob?.company}
              onBack={navigateToDashboardList}
            />
          ) : (
            <section className="space-y-6">
              <header className="space-y-2">
                <h1 className="text-xl font-semibold tracking-tight text-slate-900">Job Dashboard</h1>
                <p className="text-sm text-slate-500">All active opportunities in one board view.</p>
              </header>

              {onboardingSuccess ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  {onboardingSuccess}
                </div>
              ) : null}

              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 md:flex-row md:items-center">
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search by title, company..."
                    className="md:flex-1"
                  />
                  <div className="flex gap-2">
                    <Button type="button" variant="ghost">All</Button>
                    <Button type="button" variant="ghost">Saved</Button>
                    <Button type="button" variant="ghost">Apply</Button>
                  </div>
                </div>
              </div>

              <JobList jobs={filteredJobs} isLoading={isLoadingJobs} onViewDetails={handleViewDetails} onAddJob={onAddJob} />
            </section>
          )
        }
      />

      {approvalDraft ? (
        <PreApplyApprovalDialog
          open={approvalOpen}
          draft={approvalDraft}
          onOpenChange={setApprovalOpen}
          onApproved={onApprovalAccepted}
          onRejected={onApprovalRejected}
        />
      ) : null}
    </>
  );
}
