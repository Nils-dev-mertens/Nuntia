CREATE TABLE `spam_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `spam_rules_user_position_idx` ON `spam_rules` (`user_id`,`position`);--> statement-breakpoint
CREATE TABLE `spam_sender_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`sender_email` text NOT NULL,
	`spam_at` integer,
	`not_spam_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spam_sender_signals_account_email_idx` ON `spam_sender_signals` (`account_id`,`sender_email`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `folder` text DEFAULT 'inbox' NOT NULL;--> statement-breakpoint
CREATE INDEX `conversations_folder_idx` ON `conversations` (`account_id`,`folder`);--> statement-breakpoint
UPDATE `conversations` SET `folder` = 'archive' WHERE `is_archived` = 1;