CREATE TABLE `contact_tags` (
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`tag` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `email`, `tag`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_tags_user_tag_idx` ON `contact_tags` (`user_id`,`tag`);