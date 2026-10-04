CREATE TABLE `sender_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`sender_email` text NOT NULL,
	`strip_quoted_history` integer DEFAULT true NOT NULL,
	`strip_greeting` integer DEFAULT true NOT NULL,
	`strip_signature` integer DEFAULT true NOT NULL,
	`reply_style_enabled` integer DEFAULT false NOT NULL,
	`reply_greeting` text,
	`reply_signature` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sender_profiles_account_email_idx` ON `sender_profiles` (`account_id`,`sender_email`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `default_reply_greeting` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `default_reply_signature` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `detected_greeting_text` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `detected_signature_text` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `stripped_quote` text;