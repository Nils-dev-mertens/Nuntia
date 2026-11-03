PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_organization_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`user_id` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_organization_labels`("id", "organization_id", "user_id", "name", "description", "enabled", "position", "created_at", "updated_at") SELECT "id", NULL, "user_id", "name", "description", "enabled", "position", "created_at", "updated_at" FROM `organization_labels`;--> statement-breakpoint
DROP TABLE `organization_labels`;--> statement-breakpoint
ALTER TABLE `__new_organization_labels` RENAME TO `organization_labels`;--> statement-breakpoint
UPDATE `organization_labels`
SET `organization_id` = 'org:' || `user_id`
WHERE `organization_id` IS NULL;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `organization_labels_organization_position_idx` ON `organization_labels` (`organization_id`,`position`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `assigned_to` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `conversations` ADD `assigned_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `conversations` ADD `assigned_at` integer;