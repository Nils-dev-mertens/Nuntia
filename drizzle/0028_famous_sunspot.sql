CREATE TABLE `context_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`target` text NOT NULL,
	`field` text NOT NULL,
	`previous_value` text,
	`next_value` text,
	`source` text NOT NULL,
	`thread_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`undone_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `context_revisions_target_idx` ON `context_revisions` (`user_id`,`target`,`created_at`);