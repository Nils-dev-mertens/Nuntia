CREATE TABLE `access_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`note` text NOT NULL,
	`source` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`invite_id` text,
	`decided_by` text,
	`declined_reason` text,
	`decided_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`invite_id`) REFERENCES `invites`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_requests_pending_email_idx` ON `access_requests` (`email`) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX `access_requests_status_idx` ON `access_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text,
	`rating` integer,
	`message` text NOT NULL,
	`context` text,
	`status` text DEFAULT 'new' NOT NULL,
	`resolution_note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feedback_status_idx` ON `feedback` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `invite_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`invite_id` text NOT NULL,
	`user_id` text NOT NULL,
	`user_agent` text,
	`redeemed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`invite_id`) REFERENCES `invites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invite_redemptions_invite_idx` ON `invite_redemptions` (`invite_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invite_redemptions_pair_idx` ON `invite_redemptions` (`invite_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`label` text,
	`email` text,
	`max_uses` integer DEFAULT 1 NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`notified_at` integer,
	`notify_error` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_code_hash_idx` ON `invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `invites_email_idx` ON `invites` (`email`);--> statement-breakpoint
CREATE TABLE `product_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`conversation_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_events_user_idx` ON `product_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `product_events_name_idx` ON `product_events` (`name`,`created_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'member' NOT NULL;