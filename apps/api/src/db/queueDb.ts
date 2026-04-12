import { prisma } from "./prisma.js";

export interface QueueJobState {
  job_id: string;
  user_id?: string;
  job_url?: string;
  status: "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "PARTIAL_SUCCESS" | "CANCELLED";
  steps: {
    analyze?: any;
    patched_resume?: any;
    answers?: any;
    apply?: any;
  };
  result: Record<string, any>;
  errors: string[];
}

export async function getQueueJobState(job_id: string): Promise<QueueJobState | null> {
  const job = await prisma.queueJob.findUnique({ where: { id: job_id } });
  if (!job) return null;
  return {
    job_id: job.id,
    user_id: job.userId || undefined,
    job_url: job.jobUrl || undefined,
    status: job.status as QueueJobState["status"],
    steps: job.steps as any,
    result: job.result as any,
    errors: job.errors as any
  };
}

export async function initQueueJobState(job_id: string, user_id?: string, job_url?: string): Promise<QueueJobState> {
  const existing = await getQueueJobState(job_id);
  if (existing) return existing;

  const newState: QueueJobState = {
    job_id,
    user_id,
    job_url,
    status: "PENDING",
    steps: {},
    result: {},
    errors: []
  };
  
  await prisma.queueJob.create({
    data: {
      id: job_id,
      userId: user_id,
      jobUrl: job_url,
      status: newState.status,
      steps: newState.steps,
      result: newState.result,
      errors: newState.errors
    }
  });

  return newState;
}

export async function updateQueueJobState(state: QueueJobState) {
  await prisma.queueJob.update({
    where: { id: state.job_id },
    data: {
      userId: state.user_id,
      jobUrl: state.job_url,
      status: state.status,
      steps: state.steps,
      result: state.result,
      errors: state.errors
    }
  });
}
