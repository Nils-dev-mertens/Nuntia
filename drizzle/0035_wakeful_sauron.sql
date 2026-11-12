CREATE TABLE `contact_tag_descriptions` (
	`user_id` text NOT NULL,
	`tag` text NOT NULL,
	`description` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `tag`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
