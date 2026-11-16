CREATE TABLE `contact_organizations` (
	`user_id` text NOT NULL,
	`domain` text NOT NULL,
	`focus` text,
	`focus_source` text,
	`suggested_focus` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `domain`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
