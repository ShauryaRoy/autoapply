-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('queued', 'running', 'paused', 'waiting_user_action', 'completed', 'failed');

-- CreateTable
CREATE TABLE "ApplicationRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobUrl" TEXT NOT NULL,
    "targetRole" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'queued',
    "currentStep" TEXT NOT NULL,
    "atsProvider" TEXT NOT NULL,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "checkpointJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationEvent" (
    "id" TEXT NOT NULL,
    "applicationRunId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadLetterJob" (
    "id" TEXT NOT NULL,
    "queueName" TEXT NOT NULL,
    "originalJobId" TEXT NOT NULL,
    "applicationId" TEXT,
    "userId" TEXT,
    "step" TEXT,
    "reason" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeadLetterJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApplicationRun_userId_createdAt_idx" ON "ApplicationRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ApplicationRun_status_updatedAt_idx" ON "ApplicationRun"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ApplicationEvent_applicationRunId_createdAt_idx" ON "ApplicationEvent"("applicationRunId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCredential_userId_provider_key" ON "IntegrationCredential"("userId", "provider");

-- CreateIndex
CREATE INDEX "DeadLetterJob_queueName_status_createdAt_idx" ON "DeadLetterJob"("queueName", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "ApplicationEvent" ADD CONSTRAINT "ApplicationEvent_applicationRunId_fkey" FOREIGN KEY ("applicationRunId") REFERENCES "ApplicationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadLetterJob" ADD CONSTRAINT "DeadLetterJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
