-- CreateTable
CREATE TABLE "tbl_export_tokens" (
    "id" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "token_name" TEXT,
    "issued_by" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "revoke_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_export_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tbl_export_tokens_jti_key" ON "tbl_export_tokens"("jti");

-- CreateIndex
CREATE INDEX "tbl_export_tokens_issued_by_idx" ON "tbl_export_tokens"("issued_by");

-- CreateIndex
CREATE INDEX "tbl_export_tokens_expires_at_idx" ON "tbl_export_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "tbl_export_tokens_revoked_at_idx" ON "tbl_export_tokens"("revoked_at");
