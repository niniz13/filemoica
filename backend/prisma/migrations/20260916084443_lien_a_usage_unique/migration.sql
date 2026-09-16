-- AlterTable
ALTER TABLE "shares" ADD COLUMN     "burn_after_download" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "consumed_at" TIMESTAMP(3);
