CREATE INDEX "logs_created_idx" ON "logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "logs_listened_idx" ON "logs" USING btree ("listened_on");--> statement-breakpoint
CREATE INDEX "logs_review_created_idx" ON "logs" USING btree ("created_at") WHERE "logs"."review" IS NOT NULL;