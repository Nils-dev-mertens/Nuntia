PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_organization_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_organization_labels`("id", "organization_id", "name", "description", "enabled", "position", "created_at", "updated_at") SELECT "id", "organization_id", "name", "description", "enabled", "position", "created_at", "updated_at" FROM `organization_labels`;--> statement-breakpoint
DROP TABLE `organization_labels`;--> statement-breakpoint
ALTER TABLE `__new_organization_labels` RENAME TO `organization_labels`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `organization_labels_organization_position_idx` ON `organization_labels` (`organization_id`,`position`);