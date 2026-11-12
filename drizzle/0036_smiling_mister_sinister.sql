CREATE TABLE `contact_tag_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tag` text NOT NULL,
	`email` text NOT NULL,
	`action` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_tag_events_user_tag_created_idx` ON `contact_tag_events` (`user_id`,`tag`,`created_at`);--> statement-breakpoint
ALTER TABLE `contact_tag_descriptions` ADD `source` text DEFAULT 'user' NOT NULL;