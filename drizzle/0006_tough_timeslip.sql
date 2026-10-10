CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`jev_api_key_encrypted` text,
	`jev_model` text,
	`llm_provider` text,
	`llm_model` text,
	`llm_api_key_encrypted` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
