import { workerWriteDlq } from "./apiClient.js";

interface DlqInput {
  queueName: string;
  originalJobId: string;
  applicationId?: string;
  userId?: string;
  step?: string;
  reason: string;
  payload: unknown;
}

export async function writeDeadLetter(input: DlqInput): Promise<void> {
  await workerWriteDlq({
    queueName: input.queueName,
    originalJobId: input.originalJobId,
    applicationId: input.applicationId,
    userId: input.userId,
    step: input.step,
    reason: input.reason,
    payloadJson: (input.payload ?? {}) as Record<string, unknown>
  });
}
