-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'PREMIUM');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "plan" "Plan" NOT NULL DEFAULT 'FREE';

-- CreateTable
CREATE TABLE "monthly_usage" (
    "id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "user_id" UUID NOT NULL,

    CONSTRAINT "monthly_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "monthly_usage_user_id_period_key" ON "monthly_usage"("user_id", "period");

-- AddForeignKey
ALTER TABLE "monthly_usage" ADD CONSTRAINT "monthly_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
