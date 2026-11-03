CREATE TABLE `organization_ai_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`jev_api_key_encrypted` text,
	`jev_model` text,
	`llm_provider` text,
	`llm_model` text,
	`llm_api_key_encrypted` text,
	`suggest_reply_min_importance` integer DEFAULT 6 NOT NULL,
	`goal_check_enabled` integer DEFAULT true NOT NULL,
	`auto_context_enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `organization_ai_settings` (
	`organization_id`,
	`jev_api_key_encrypted`,
	`jev_model`,
	`llm_provider`,
	`llm_model`,
	`llm_api_key_encrypted`,
	`suggest_reply_min_importance`,
	`goal_check_enabled`,
	`auto_context_enabled`,
	`updated_at`
)
SELECT
	'org:' || `user_id`,
	`jev_api_key_encrypted`,
	`jev_model`,
	`llm_provider`,
	`llm_model`,
	`llm_api_key_encrypted`,
	`suggest_reply_min_importance`,
	`goal_check_enabled`,
	`auto_context_enabled`,
	`updated_at`
FROM `app_settings`
WHERE `user_id` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `jev_api_key_encrypted`;--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `jev_model`;--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `llm_provider`;--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `llm_model`;--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `llm_api_key_encrypted`;--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `suggest_reply_min_importance`;--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `goal_check_enabled`;--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `auto_context_enabled`;
