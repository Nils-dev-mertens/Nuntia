CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_organization_idx` ON `memberships` (`organization_id`);--> statement-breakpoint
CREATE TABLE `organization_clients` (
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`kind` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`organization_id`, `email`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `organization_clients_email_idx` ON `organization_clients` (`email`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'solo' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `organizations` (`id`, `name`, `kind`, `created_at`, `updated_at`)
SELECT 'org:' || `id`, COALESCE(NULLIF(TRIM(`name`), ''), `email`), 'solo', (unixepoch() * 1000), (unixepoch() * 1000)
FROM `users`;--> statement-breakpoint
INSERT INTO `memberships` (`id`, `organization_id`, `user_id`, `role`, `created_at`)
SELECT 'mem:' || `id`, 'org:' || `id`, `id`, 'owner', (unixepoch() * 1000)
FROM `users`;--> statement-breakpoint
INSERT INTO `organization_clients` (`organization_id`, `email`, `kind`, `updated_at`)
SELECT 'org:' || `user_id`, `email`, `kind`, `updated_at`
FROM `contact_contexts`
WHERE `kind` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `contact_contexts` DROP COLUMN `kind`;