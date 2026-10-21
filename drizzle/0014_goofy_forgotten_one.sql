CREATE TABLE `contacts` (
	`account_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`account_id`, `email`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contacts_email_idx` ON `contacts` (`email`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `push_expires_at` integer;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `use_gravatar` integer DEFAULT false NOT NULL;