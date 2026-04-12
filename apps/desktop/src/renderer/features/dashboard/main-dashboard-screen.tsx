import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createApplication,
  getApplication,
  getLatestPreview,
  pauseApplication,
  resumeApplication,
  subscribeToApplication,
  type UserProfile
} from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Badge } from "../../components/ui/badge.js";
import { ToastProvider, useToast } from "../../components/ui/toast.js";
import { getInternetJobs } from "../../api/queue.js";
import type { InternetJobItem } from "../../api/contracts.js";
import { deriveMatchScore, getResumeDiff, inferDecision, ORDERED_PIPELINE } from "./data.js";
import { ApprovalModal } from "./components/approval-modal.js";
import { DashboardSidebar } from "./components/dashboard-sidebar.js";
import { ExecutionLogs } from "./components/execution-logs.js";
import { JobInputPanel } from "./components/job-input-panel.js";
import { JobIntelligenceCard } from "./components/job-intelligence-card.js";
import { LiveAutomationPreview } from "./components/live-automation-preview.js";
import { PipelineStepper } from "./components/pipeline-stepper.js";
import { ResumeDiffPreview } from "./components/resume-diff-preview.js";
import { DashboardLayout } from "../../layouts/dashboard-layout.js";
import type { DashboardLog, PipelineStep } from "./types.js";

type EventLog = {
  id: string;
  step: string;
  message: string;
  createdAt: string;
  payloadJson?: { screenshotPath?: string; screenshotUrl?: string; [key: string]: unknown };
};

type AppData = {
  id: string;
  currentStep: string;
  status: string;
  jobUrl: string;
  targetRole: string;
  events: EventLog[];
};

type MainDashboardScreenProps = {
  user: { firstName: string; lastName: string; email: string };
  profile: UserProfile;
  onEditProfile: () => void;
  onLogout: () => void;
};

type DashboardNavItem = "Apply" | "Jobs" | "Settings";

type JobHistoryItem = {
  id: string;
  jobUrl: string;
  targetRole: string;
  status: string;
  currentStep: string;
  updatedAt: string;
};

const JOB_HISTORY_STORAGE_KEY = "autoapply_dashboard_job_history";

function normalizeStepLabel(step: string): string {
  return step.replace(/_/g, " ");
}

function mapPipelineSteps(currentStep: string): PipelineStep[] {
  const currentIndex = ORDERED_PIPELINE.indexOf(currentStep as (typeof ORDERED_PIPELINE)[number]);
  return ORDERED_PIPELINE.map((step, index) => {
    const state = currentIndex > index ? "completed" : currentIndex === index ? "active" : "pending";
    return {
      id: step,
      label: normalizeStepLabel(step),
      state
    };
  });
}

function mapLogs(events: EventLog[]): DashboardLog[] {
  return [...events]
    .reverse()
    .slice(0, 30)
    .map((event) => {
      let status: DashboardLog["status"] = "running";
      const step = event.step.toLowerCase();
      const message = event.message.toLowerCase();

      if (message.includes("error") || message.includes("failed")) status = "error";
      else if (step.includes("submitted") || message.includes("complete")) status = "success";
      else if (message.includes("retry") || message.includes("warn")) status = "warning";

      return {
        id: event.id,
        timestamp: new Date(event.createdAt).toLocaleTimeString(),
        action: event.message || normalizeStepLabel(event.step),
        status
      };
    });
}

function safeCompanyHost(url: string | undefined): string {
  if (!url) return "Waiting for job URL";
  try {
    return new URL(url).hostname;
  } catch {
    return "Waiting for job URL";
  }
}

function readJobHistoryFromStorage(): JobHistoryItem[] {
  try {
    const raw = localStorage.getItem(JOB_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((entry) => {
        const record = entry as Partial<JobHistoryItem>;
        if (!record?.id || !record?.jobUrl) return null;
        return {
          id: record.id,
          jobUrl: record.jobUrl,
          targetRole: record.targetRole ?? "Untitled role",
          status: record.status ?? "queued",
          currentStep: record.currentStep ?? "queued",
          updatedAt: record.updatedAt ?? new Date(0).toISOString()
        };
      })
      .filter((entry): entry is JobHistoryItem => !!entry);
  } catch {
    return [];
  }
}

function writeJobHistoryToStorage(items: JobHistoryItem[]): void {
  localStorage.setItem(JOB_HISTORY_STORAGE_KEY, JSON.stringify(items));
}

function MainDashboardScreenInner({ user, profile, onEditProfile, onLogout }: MainDashboardScreenProps) {
  const { pushToast } = useToast();
  const [activeItem, setActiveItem] = useState<DashboardNavItem>("Apply");
  const [jobUrl, setJobUrl] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [runData, setRunData] = useState<AppData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [livePreviewUrl, setLivePreviewUrl] = useState("");
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [jobSearch, setJobSearch] = useState("");
  const [jobHistory, setJobHistory] = useState<JobHistoryItem[]>([]);
  const [internetJobs, setInternetJobs] = useState<InternetJobItem[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string>("");
  const [jobsMeta, setJobsMeta] = useState<{ scanned: number; fetched: number; fromCache: boolean }>({
    scanned: 0,
    fetched: 0,
    fromCache: false
  });

  const previewPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const matchedSkills = useMemo(
    () => (profile.skills ?? []).map((skill) => skill.name).filter(Boolean).slice(0, 5),
    [profile.skills]
  );
  const missingSkills = useMemo(() => ["System Design", "GraphQL", "A/B Testing"], []);
  const matchScore = useMemo(() => deriveMatchScore(targetRole, matchedSkills.length), [targetRole, matchedSkills.length]);
  const decision = useMemo(() => inferDecision(matchScore), [matchScore]);
  const resumeDiff = useMemo(() => getResumeDiff(matchedSkills), [matchedSkills]);

  const eventPreviewUrl = useMemo(() => {
    const events = runData?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const payload = events[i].payloadJson;
      const url = payload?.screenshotUrl;
      if (url && typeof url === "string") return url;
    }
    return "";
  }, [runData]);

  const latestPreview = livePreviewUrl || eventPreviewUrl;

  const upsertJobHistory = useCallback((details: AppData) => {
    setJobHistory((previous) => {
      const nextItem: JobHistoryItem = {
        id: details.id,
        jobUrl: details.jobUrl,
        targetRole: details.targetRole || "Untitled role",
        status: details.status,
        currentStep: details.currentStep,
        updatedAt: new Date().toISOString()
      };

      const withoutCurrent = previous.filter((item) => item.id !== details.id);
      const next = [nextItem, ...withoutCurrent].slice(0, 30);
      writeJobHistoryToStorage(next);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!applicationId) return;
    const details = await getApplication(applicationId);
    setRunData(details);
    upsertJobHistory(details);
  }, [applicationId, upsertJobHistory]);

  useEffect(() => {
    setJobHistory(readJobHistoryFromStorage());
  }, []);

  useEffect(() => {
    if (!applicationId) {
      setLivePreviewUrl("");
      if (previewPollRef.current) {
        clearInterval(previewPollRef.current);
        previewPollRef.current = null;
      }
      return;
    }

    previewPollRef.current = setInterval(() => {
      void getLatestPreview(applicationId).then((url) => {
        if (url) setLivePreviewUrl(`${url}?t=${Date.now()}`);
      });
    }, 2000);

    const unsub = subscribeToApplication(applicationId, () => {
      void refresh();
    });

    const interval = window.setInterval(() => {
      void refresh();
    }, 6000);

    return () => {
      unsub();
      clearInterval(interval);
      if (previewPollRef.current) {
        clearInterval(previewPollRef.current);
        previewPollRef.current = null;
      }
    };
  }, [applicationId, refresh]);

  const createPayload = useMemo(
    () => ({
      profile: {
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        phone: profile.phone,
        location: profile.location,
        linkedIn: profile.linkedIn,
        portfolio: profile.portfolio
      },
      resumeText: profile.resumeText,
      answers: {
        "why-this-company": profile.whyCompany || "I am excited about this opportunity.",
        "years-experience": profile.yearsExperience || "0"
      }
    }),
    [profile]
  );

  const startApplication = useCallback(async () => {
    if (!jobUrl || !targetRole) return;
    setError("");
    setLoading(true);
    try {
      const created = await createApplication({
        jobUrl,
        targetRole,
        metadata: createPayload
      });
      setApplicationId(created.applicationId);
      const details = await getApplication(created.applicationId);
      setRunData(details);
      upsertJobHistory(details);
      pushToast({
        title: "Automation started",
        description: "Application run is now live.",
        tone: "success"
      });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Failed to start application";
      setError(msg);
      pushToast({ title: "Failed", description: msg, tone: "danger" });
    } finally {
      setLoading(false);
    }
  }, [createPayload, jobUrl, pushToast, targetRole, upsertJobHistory]);

  const handleApproval = useCallback(() => {
    setApprovalOpen(false);
    void startApplication();
  }, [startApplication]);

  const handlePause = useCallback(async () => {
    if (!applicationId) return;
    await pauseApplication(applicationId);
    await refresh();
    pushToast({ title: "Paused", description: "Automation paused.", tone: "accent" });
  }, [applicationId, pushToast, refresh]);

  const handleResume = useCallback(async () => {
    if (!applicationId) return;
    await resumeApplication(applicationId);
    await refresh();
    pushToast({ title: "Resumed", description: "Automation resumed.", tone: "success" });
  }, [applicationId, pushToast, refresh]);

  const pipelineSteps = mapPipelineSteps(runData?.currentStep ?? "");
  const logs = mapLogs(runData?.events ?? []);
  const completedEventCount = useMemo(
    () => (runData?.events ?? []).filter((event) => event.step.toLowerCase().includes("submitted")).length,
    [runData?.events]
  );

  const filteredJobs = useMemo(() => {
    const query = jobSearch.trim().toLowerCase();
    if (!query) return jobHistory;

    return jobHistory.filter((item) => {
      return (
        item.targetRole.toLowerCase().includes(query) ||
        safeCompanyHost(item.jobUrl).toLowerCase().includes(query) ||
        item.jobUrl.toLowerCase().includes(query)
      );
    });
  }, [jobHistory, jobSearch]);

  const loadInternetJobs = useCallback(async (refresh = false) => {
    setJobsLoading(true);
    setJobsError("");
    try {
      const response = await getInternetJobs({
        query: jobSearch,
        refresh,
        limit: 120
      });
      setInternetJobs(response.jobs);
      setJobsMeta({
        scanned: response.totalScannedCompanies,
        fetched: response.totalFetchedJobs,
        fromCache: response.fromCache
      });
      if (response.errors.length > 0) {
        setJobsError(`Some sources failed (${response.errors.length}). Showing available jobs.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load internet jobs";
      setJobsError(message);
      setInternetJobs([]);
    } finally {
      setJobsLoading(false);
    }
  }, [jobSearch]);

  useEffect(() => {
    if (activeItem !== "Jobs" && activeItem !== "Apply") return;
    const timer = window.setTimeout(() => {
      void loadInternetJobs(false);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeItem, jobSearch, loadInternetJobs]);

  const jobsBoard = (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Internet Jobs</h2>
          <p className="text-sm text-slate-500">Live feed from company ATS APIs.</p>
        </div>
        <Button type="button" variant="default" onClick={() => void loadInternetJobs(true)}>
          Refresh Jobs
        </Button>
      </div>

      <Input
        value={jobSearch}
        onChange={(event) => setJobSearch(event.target.value)}
        placeholder="Search by role or company..."
      />

      {jobsError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">{jobsError}</div>
      ) : null}

      {jobsLoading ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
          Scanning company APIs for jobs...
        </div>
      ) : null}

      {!jobsLoading && internetJobs.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {internetJobs.map((job) => (
            <article key={job.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm text-slate-500">{job.company}</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{job.title}</p>
                </div>
                <Badge tone="accent">internet</Badge>
              </div>

              <p className="mt-2 text-xs text-slate-500">{job.location || "Location not specified"}</p>
              <p className="mt-1 line-clamp-1 text-xs text-slate-500">{job.url}</p>

              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1"
                  onClick={() => window.open(job.url, "_blank", "noopener,noreferrer")}
                >
                  Open Job
                </Button>
                <Button
                  type="button"
                  variant="default"
                  className="flex-1"
                  onClick={() => {
                    setJobUrl(job.url);
                    setTargetRole(job.title);
                    setActiveItem("Apply");
                  }}
                >
                  Use In Apply
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {!jobsLoading && internetJobs.length === 0 && filteredJobs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
          No jobs found yet. Try refreshing the feed.
        </div>
      ) : null}

      {!jobsLoading && internetJobs.length === 0 && filteredJobs.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredJobs.map((item) => (
            <article key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm text-slate-500">{safeCompanyHost(item.jobUrl)}</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{item.targetRole}</p>
                </div>
                <Badge tone={item.status.toLowerCase().includes("fail") ? "danger" : item.status.toLowerCase().includes("complete") ? "success" : "accent"}>
                  {item.status}
                </Badge>
              </div>

              <p className="mt-2 text-xs text-slate-500">Current step: {normalizeStepLabel(item.currentStep)}</p>
              <p className="mt-1 text-xs text-slate-500">Updated {new Date(item.updatedAt).toLocaleString()}</p>

              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1"
                  onClick={() => {
                    setApplicationId(item.id);
                    setActiveItem("Apply");
                  }}
                >
                  Open
                </Button>
                <Button
                  type="button"
                  variant="default"
                  className="flex-1"
                  onClick={() => window.open(item.jobUrl, "_blank", "noopener,noreferrer")}
                >
                  View Job
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );

  const leftRail =
    activeItem === "Apply" ? (
      <div className="space-y-4">
        <JobInputPanel
          jobUrl={jobUrl}
          targetRole={targetRole}
          loading={loading}
          hasApplication={!!applicationId}
          error={error}
          onJobUrlChange={setJobUrl}
          onTargetRoleChange={setTargetRole}
          onSubmit={() => setApprovalOpen(true)}
        />
        {applicationId ? (
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={handlePause} variant="ghost">Pause</Button>
            <Button onClick={handleResume} variant="ghost">Resume</Button>
            <Button onClick={() => void refresh()} className="col-span-2" variant="default">Refresh run</Button>
          </div>
        ) : null}
      </div>
    ) : activeItem === "Jobs" ? (
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm text-slate-500">Jobs</p>
        <h2 className="text-xl font-semibold text-slate-900">Internet Job Feed</h2>
        <p className="text-sm text-slate-500">Pulled from company ATS APIs inspired by career-ops scan.</p>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Scanned {jobsMeta.scanned} sources, fetched {jobsMeta.fetched} jobs {jobsMeta.fromCache ? "(cached)" : "(live)"}
        </div>
        <div className="space-y-2 text-sm text-slate-700">
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
            <span>Current status</span>
            <span className="font-medium text-slate-900">{runData?.status ?? "idle"}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
            <span>Current step</span>
            <span className="font-medium text-slate-900">{runData?.currentStep ?? "not started"}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
            <span>Submitted events</span>
            <span className="font-medium text-slate-900">{completedEventCount}</span>
          </div>
        </div>
        <Button onClick={() => void loadInternetJobs(true)} className="w-full" variant="default">Refresh Internet Jobs</Button>
      </div>
    ) : (
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm text-slate-500">Settings</p>
        <h2 className="text-xl font-semibold text-slate-900">Account Settings</h2>
        <div className="space-y-2 text-sm text-slate-700">
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-500">Name</p>
            <p className="font-medium text-slate-900">{user.firstName} {user.lastName}</p>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-500">Email</p>
            <p className="font-medium text-slate-900">{user.email}</p>
          </div>
        </div>
        <Button onClick={onEditProfile} className="w-full" variant="default">Edit Profile Details</Button>
      </div>
    );

  const main =
    activeItem === "Apply" ? (
      <>
        <PipelineStepper steps={pipelineSteps} />
        <div className="grid gap-6 lg:grid-cols-2">
          <JobIntelligenceCard
            title={targetRole || "Role not set"}
            company={safeCompanyHost(runData?.jobUrl)}
            matchScore={matchScore}
            matchedSkills={matchedSkills}
            missingSkills={missingSkills}
            decision={decision}
          />
          <ResumeDiffPreview lines={resumeDiff} />
        </div>
        <div className="grid gap-6 2xl:grid-cols-2">
          <LiveAutomationPreview
            previewUrl={latestPreview}
            status={runData?.status ?? "idle"}
            loading={loading}
          />
          <ExecutionLogs logs={logs} />
        </div>
        {jobsBoard}
      </>
    ) : activeItem === "Jobs" ? (
      jobsBoard
    ) : (
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Settings</h2>
        <p className="text-sm text-slate-500">Your profile is saved. You can review details and edit anytime.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-500">Phone</p>
            <p className="font-medium text-slate-900">{profile.phone || "Not set"}</p>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-500">Location</p>
            <p className="font-medium text-slate-900">{profile.location || "Not set"}</p>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2 sm:col-span-2">
            <p className="text-xs text-slate-500">Desired roles</p>
            <p className="font-medium text-slate-900">{(profile.roles?.desiredRoles ?? []).join(", ") || "Not set"}</p>
          </div>
        </div>
        <Button onClick={onEditProfile} variant="default">Open Full Profile</Button>
      </div>
    );

  return (
    <DashboardLayout
      sidebar={
        <DashboardSidebar
          userName={`${user.firstName} ${user.lastName}`}
          userEmail={user.email}
          activeItem={activeItem}
          onNavigateApply={() => setActiveItem("Apply")}
          onNavigateJobs={() => setActiveItem("Jobs")}
          onNavigateProfile={onEditProfile}
          onNavigateSettings={() => setActiveItem("Settings")}
          onLogout={onLogout}
        />
      }
      leftRail={leftRail}
      main={main}
    >
      <ApprovalModal
        open={approvalOpen}
        onOpenChange={setApprovalOpen}
        score={matchScore}
        resumeDiff={resumeDiff}
        generatedAnswers={[
          {
            prompt: "Why do you want to join this company?",
            answer: profile.whyCompany || "The mission and product quality strongly align with my experience."
          },
          {
            prompt: "How many years of experience do you have?",
            answer: `${profile.yearsExperience || "3"} years in modern frontend engineering.`
          }
        ]}
        onApprove={handleApproval}
        onEdit={() => {
          setApprovalOpen(false);
          onEditProfile();
        }}
        onReject={() => {
          setApprovalOpen(false);
          pushToast({ title: "Rejected", description: "Application run canceled.", tone: "danger" });
        }}
      />
    </DashboardLayout>
  );
}

export function MainDashboardScreen(props: MainDashboardScreenProps) {
  return (
    <ToastProvider>
      <MainDashboardScreenInner {...props} />
    </ToastProvider>
  );
}
