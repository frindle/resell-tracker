-- AlterTable
ALTER TABLE "PhotoOcr" ADD COLUMN "draft" TEXT;
ALTER TABLE "PhotoOcr" ADD COLUMN "draftRejected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PhotoOcr" ADD COLUMN "rejectedOrderIds" TEXT;
