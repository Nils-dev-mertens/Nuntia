CREATE TABLE `reply_styles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`greeting` text,
	`signature` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reply_styles_user_idx` ON `reply_styles` (`user_id`);--> statement-breakpoint
ALTER TABLE `sender_profiles` ADD `reply_style_id` text REFERENCES reply_styles(id) ON DELETE SET NULL;