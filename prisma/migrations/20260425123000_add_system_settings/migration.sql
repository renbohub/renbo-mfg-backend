-- CreateTable
CREATE TABLE "tbl_system_settings" (
    "id" TEXT NOT NULL,
    "setting_key" TEXT NOT NULL,
    "setting_value" TEXT NOT NULL,
    "description" TEXT,
    "updated_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tbl_system_settings_setting_key_key" ON "tbl_system_settings"("setting_key");
CREATE INDEX "tbl_system_settings_setting_key_idx" ON "tbl_system_settings"("setting_key");
CREATE INDEX "tbl_system_settings_is_deleted_idx" ON "tbl_system_settings"("is_deleted");
