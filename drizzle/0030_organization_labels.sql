-- Split a custom label from the test that finds its mail.
--
-- Before this, one `organization_rules` row was simultaneously the label (name,
-- meaning, enabled, order) and its single match test, which meant a label could
-- only ever match one field, and "chosen by its meaning" had to be encoded as a
-- rule whose field was a fake `meaning` value that matched nothing.
--
-- The label keeps the old row's id, so `conversations.organization_group_id` and
-- the `label:<id>` tokens in `app_settings.inbox_order` keep pointing at the same
-- thing. The rule takes a new id derived from the same row, and a row whose field
-- was `meaning` becomes a label with no rule at all.
CREATE TABLE `organization_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `organization_labels` (`id`,`user_id`,`name`,`description`,`enabled`,`position`,`created_at`,`updated_at`)
SELECT `id`,`user_id`,`name`,`description`,`enabled`,`position`,`created_at`,`updated_at` FROM `organization_rules`;
--> statement-breakpoint
CREATE INDEX `organization_labels_user_position_idx` ON `organization_labels` (`user_id`,`position`);
--> statement-breakpoint
CREATE TABLE `organization_rules_new` (
	`id` text PRIMARY KEY NOT NULL,
	`label_id` text NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`label_id`) REFERENCES `organization_labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `organization_rules_new` (`id`,`label_id`,`field`,`value`,`position`)
SELECT 'rule-' || `id`,`id`,`field`,`value`,0 FROM `organization_rules` WHERE `field` <> 'meaning';
--> statement-breakpoint
DROP TABLE `organization_rules`;
--> statement-breakpoint
ALTER TABLE `organization_rules_new` RENAME TO `organization_rules`;
--> statement-breakpoint
CREATE INDEX `organization_rules_label_position_idx` ON `organization_rules` (`label_id`,`position`);
