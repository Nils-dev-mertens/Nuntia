CREATE TABLE `contact_contexts` (
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`role_company` text,
	`relationship` text,
	`topics` text,
	`current_work` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `email`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_contexts_email_idx` ON `contact_contexts` (`email`);