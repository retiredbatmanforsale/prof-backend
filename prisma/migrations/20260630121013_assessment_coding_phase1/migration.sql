-- CreateEnum
CREATE TYPE "IntegrityEventType" AS ENUM ('TAB_SWITCH', 'FULLSCREEN_EXIT', 'FULLSCREEN_ENTER', 'COPY_ATTEMPT', 'CUT_ATTEMPT', 'PASTE_ATTEMPT', 'CONTEXT_MENU', 'WARNING_ISSUED', 'AUTO_SUBMIT', 'FOCUS_LOSS', 'RESUME');

-- AlterTable
ALTER TABLE "assessment_attempts" ADD COLUMN     "lastActiveQuestionId" TEXT;

-- AlterTable
ALTER TABLE "assessments" ADD COLUMN     "blockClipboard" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "detectTabSwitch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxWarnings" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "requireFullscreen" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "code_submissions" ADD COLUMN     "attemptId" TEXT,
ADD COLUMN     "clientFingerprint" TEXT,
ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "userAgent" TEXT;

-- CreateTable
CREATE TABLE "assessment_events" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "IntegrityEventType" NOT NULL,
    "questionId" TEXT,
    "warnable" BOOLEAN NOT NULL DEFAULT false,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "fingerprint" TEXT,
    "clientTs" TIMESTAMP(3),
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_integrity" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tabSwitchCount" INTEGER NOT NULL DEFAULT 0,
    "fullscreenExitCount" INTEGER NOT NULL DEFAULT 0,
    "copyAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "pasteAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "contextMenuCount" INTEGER NOT NULL DEFAULT 0,
    "focusLossCount" INTEGER NOT NULL DEFAULT 0,
    "warningsIssued" INTEGER NOT NULL DEFAULT 0,
    "maxWarnings" INTEGER NOT NULL DEFAULT 3,
    "terminated" BOOLEAN NOT NULL DEFAULT false,
    "terminatedReason" TEXT,
    "terminatedAt" TIMESTAMP(3),
    "firstIp" TEXT,
    "firstUserAgent" TEXT,
    "firstFingerprint" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessment_integrity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assessment_events_attemptId_idx" ON "assessment_events"("attemptId");

-- CreateIndex
CREATE INDEX "assessment_events_assessmentId_type_idx" ON "assessment_events"("assessmentId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_integrity_attemptId_key" ON "assessment_integrity"("attemptId");

-- CreateIndex
CREATE INDEX "assessment_integrity_assessmentId_idx" ON "assessment_integrity"("assessmentId");

-- CreateIndex
CREATE INDEX "code_submissions_attemptId_idx" ON "code_submissions"("attemptId");

-- CreateIndex
CREATE INDEX "code_submissions_attemptId_assessmentQuestionId_idx" ON "code_submissions"("attemptId", "assessmentQuestionId");

-- AddForeignKey
ALTER TABLE "assessment_events" ADD CONSTRAINT "assessment_events_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "assessment_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_integrity" ADD CONSTRAINT "assessment_integrity_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "assessment_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
