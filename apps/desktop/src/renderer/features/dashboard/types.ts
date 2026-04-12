export type PipelineState = "pending" | "active" | "completed";

export type PipelineStep = {
  id: string;
  label: string;
  state: PipelineState;
};

export type Decision = "APPLY" | "SKIP" | "RISKY";

export type ResumeDiffLine = {
  before: string;
  after: string;
  injectedKeywords: string[];
};

export type DashboardLog = {
  id: string;
  timestamp: string;
  action: string;
  status: "success" | "running" | "warning" | "error";
};
