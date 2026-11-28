-- CreateTable
CREATE TABLE "InboxTriage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "messageId" TEXT NOT NULL,
    "fromDomain" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "receivedAt" DATETIME,
    "status" TEXT NOT NULL,
    "jobId" TEXT,
    "error" TEXT,
    "category" TEXT,
    "recommend" TEXT,
    "reason" TEXT,
    "ingestKind" TEXT,
    "fields" TEXT,
    "ruleFromDomain" TEXT,
    "ruleSubject" TEXT,
    "decision" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InboxIgnoreRule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fromDomain" TEXT NOT NULL,
    "subjectContains" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "InboxTriage_messageId_key" ON "InboxTriage"("messageId");

-- CreateIndex
CREATE INDEX "InboxTriage_decision_createdAt_idx" ON "InboxTriage"("decision", "createdAt");
