export const JOB_STATUS = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  PARTIAL_SUCCESS: "PARTIAL_SUCCESS",
  CANCELLED: "CANCELLED"
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === JOB_STATUS.SUCCESS || status === JOB_STATUS.FAILED || status === JOB_STATUS.PARTIAL_SUCCESS || status === JOB_STATUS.CANCELLED;
}
