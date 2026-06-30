-- CreateEnum
CREATE TYPE "TestVisibility" AS ENUM ('SAMPLE', 'HIDDEN');

-- CreateEnum
CREATE TYPE "TestKind" AS ENUM ('CASE', 'HARNESS');

-- CreateEnum
CREATE TYPE "IoMode" AS ENUM ('FUNCTION_CALL', 'STDIN_STDOUT');

-- CreateEnum
CREATE TYPE "CheckerType" AS ENUM ('EXACT', 'ALL_CLOSE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SubmissionContext" AS ENUM ('PRACTICE', 'ASSESSMENT');

-- CreateEnum
CREATE TYPE "CodeVerdict" AS ENUM ('ACCEPTED', 'WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'RUNTIME_ERROR', 'COMPILATION_ERROR', 'PENDING', 'ERROR');

-- CreateEnum
CREATE TYPE "TestResultStatus" AS ENUM ('PASS', 'FAIL', 'ERROR');

-- AlterTable
ALTER TABLE "practice_attempts" ADD COLUMN     "bestScore" DOUBLE PRECISION,
ADD COLUMN     "lastSubmissionId" TEXT,
ADD COLUMN     "solvedLanguage" TEXT;

-- CreateTable
CREATE TABLE "problem_tests" (
    "id" TEXT NOT NULL,
    "problemSlug" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "visibility" "TestVisibility" NOT NULL DEFAULT 'HIDDEN',
    "kind" "TestKind" NOT NULL DEFAULT 'CASE',
    "ioMode" "IoMode" NOT NULL DEFAULT 'FUNCTION_CALL',
    "checkerType" "CheckerType" NOT NULL DEFAULT 'EXACT',
    "language" TEXT,
    "input" JSONB,
    "expectedOutput" JSONB,
    "rtol" DOUBLE PRECISION,
    "atol" DOUBLE PRECISION,
    "harness" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "problem_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_drafts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemSlug" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "practice_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_submissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemSlug" TEXT NOT NULL,
    "context" "SubmissionContext" NOT NULL DEFAULT 'PRACTICE',
    "assessmentId" TEXT,
    "assessmentQuestionId" TEXT,
    "organizationId" TEXT,
    "sectionId" TEXT,
    "language" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "verdict" "CodeVerdict" NOT NULL DEFAULT 'PENDING',
    "passedCount" INTEGER NOT NULL DEFAULT 0,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "score" DOUBLE PRECISION,
    "runtimeMs" INTEGER,
    "memoryKb" INTEGER,
    "testVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_test_results" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "testId" TEXT,
    "name" TEXT NOT NULL,
    "visibility" "TestVisibility" NOT NULL DEFAULT 'HIDDEN',
    "status" "TestResultStatus" NOT NULL,
    "checkerType" "CheckerType" NOT NULL,
    "toleranceApplied" JSONB,
    "numericDiff" JSONB,
    "message" TEXT,
    "runtimeMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_test_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "problem_tests_problemSlug_visibility_idx" ON "problem_tests"("problemSlug", "visibility");

-- CreateIndex
CREATE INDEX "practice_drafts_userId_idx" ON "practice_drafts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "practice_drafts_userId_problemSlug_key" ON "practice_drafts"("userId", "problemSlug");

-- CreateIndex
CREATE INDEX "code_submissions_userId_problemSlug_idx" ON "code_submissions"("userId", "problemSlug");

-- CreateIndex
CREATE INDEX "code_submissions_createdAt_idx" ON "code_submissions"("createdAt");

-- CreateIndex
CREATE INDEX "code_submissions_assessmentId_idx" ON "code_submissions"("assessmentId");

-- CreateIndex
CREATE INDEX "submission_test_results_submissionId_idx" ON "submission_test_results"("submissionId");

-- AddForeignKey
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_lastSubmissionId_fkey" FOREIGN KEY ("lastSubmissionId") REFERENCES "code_submissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_drafts" ADD CONSTRAINT "practice_drafts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_submissions" ADD CONSTRAINT "code_submissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_test_results" ADD CONSTRAINT "submission_test_results_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "code_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_test_results" ADD CONSTRAINT "submission_test_results_testId_fkey" FOREIGN KEY ("testId") REFERENCES "problem_tests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

