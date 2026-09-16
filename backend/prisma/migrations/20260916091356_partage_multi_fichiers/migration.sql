/*
  Warnings:

  - You are about to drop the column `file_id` on the `shares` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "shares" DROP CONSTRAINT "shares_file_id_fkey";

-- DropIndex
DROP INDEX "shares_file_id_idx";

-- AlterTable
ALTER TABLE "shares" DROP COLUMN "file_id";

-- CreateTable
CREATE TABLE "share_files" (
    "share_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,

    CONSTRAINT "share_files_pkey" PRIMARY KEY ("share_id","file_id")
);

-- CreateIndex
CREATE INDEX "share_files_file_id_idx" ON "share_files"("file_id");

-- AddForeignKey
ALTER TABLE "share_files" ADD CONSTRAINT "share_files_share_id_fkey" FOREIGN KEY ("share_id") REFERENCES "shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_files" ADD CONSTRAINT "share_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
