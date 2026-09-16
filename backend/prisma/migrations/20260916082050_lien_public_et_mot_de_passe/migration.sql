-- AlterTable
ALTER TABLE "shares" ADD COLUMN     "password_hash" TEXT,
ALTER COLUMN "recipient_email_enc" DROP NOT NULL,
ALTER COLUMN "recipient_email_hmac" DROP NOT NULL;
