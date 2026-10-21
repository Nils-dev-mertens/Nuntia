CREATE TABLE `organization_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `organization_rules_user_position_idx` ON `organization_rules` (`user_id`,`position`);