PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`jev_api_key_encrypted` text,
	`jev_model` text,
	`llm_provider` text,
	`llm_model` text,
	`llm_api_key_encrypted` text,
	`suggest_reply_min_importance` integer DEFAULT 6 NOT NULL,
	`goal_check_enabled` integer DEFAULT true NOT NULL,
	`auto_context_enabled` integer DEFAULT true NOT NULL,
	`use_gravatar` integer DEFAULT false NOT NULL,
	`inbox_order` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_app_settings`("id", "user_id", "jev_api_key_encrypted", "jev_model", "llm_provider", "llm_model", "llm_api_key_encrypted", "suggest_reply_min_importance", "goal_check_enabled", "auto_context_enabled", "use_gravatar", "inbox_order", "updated_at") SELECT "id", "user_id", "jev_api_key_encrypted", "jev_model", "llm_provider", "llm_model", "llm_api_key_encrypted", "suggest_reply_min_importance", "goal_check_enabled", "auto_context_enabled", "use_gravatar", "inbox_order", "updated_at" FROM `app_settings`;--> statement-breakpoint
DROP TABLE `app_settings`;--> statement-breakpoint
ALTER TABLE `__new_app_settings` RENAME TO `app_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `app_settings_user_idx` ON `app_settings` (`user_id`);--> statement-breakpoint
ALTER TABLE `contact_contexts` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `contact_contexts` ADD `sources` text;--> statement-breakpoint
UPDATE `app_settings` SET `auto_context_enabled` = 1;
