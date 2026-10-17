CREATE TABLE `sender_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`sender_email` text NOT NULL,
	`ignored_at` integer,
	`restored_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sender_signals_account_email_idx` ON `sender_signals` (`account_id`,`sender_email`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `state_override` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `state_override_message_at` integer;