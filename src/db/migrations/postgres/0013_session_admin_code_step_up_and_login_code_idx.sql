-- Issue #188 / Slice 11b-A: one-shot fresh admin_issued step-up expiry on
-- sessions (SPEC-V2 §6.8, §6.10) and composite (user_id, purpose) index on
-- login_codes for GET /v2/auth/me recovery-code check and superseding.
-- Purely additive; metadata-only nullable column addition on PostgreSQL.

ALTER TABLE "sessions" ADD COLUMN "admin_code_step_up_expires_at" bigint;
--> statement-breakpoint
CREATE INDEX "login_codes_user_purpose_idx" ON "login_codes" USING btree ("user_id","purpose");
