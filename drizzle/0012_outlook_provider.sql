-- Provider seam.
--
-- Every rename is written as a RENAME rather than the drop-and-add drizzle-kit
-- would generate from the schema diff: existing installs already hold thread,
-- message and attachment ids, and recreating the columns would silently detach
-- every stored conversation from its mail.
ALTER TABLE `accounts` ADD `provider` text DEFAULT 'google' NOT NULL;--> statement-breakpoint

ALTER TABLE `conversations` RENAME COLUMN `gmail_thread_id` TO `provider_thread_id`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `gmail_message_id` TO `provider_message_id`;--> statement-breakpoint
ALTER TABLE `attachments` RENAME COLUMN `gmail_attachment_id` TO `provider_attachment_id`;--> statement-breakpoint

-- SQLite rewrites an index when its column is renamed, then the new name is
-- created explicitly so the schema owns it under the provider-neutral name.
DROP INDEX `conversations_account_thread_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_account_thread_idx` ON `conversations` (`account_id`,`provider_thread_id`);--> statement-breakpoint
DROP INDEX `messages_conversation_gmail_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_provider_idx` ON `messages` (`conversation_id`,`provider_message_id`);--> statement-breakpoint
DROP INDEX `attachments_message_gmail_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_message_provider_idx` ON `attachments` (`message_id`,`provider_attachment_id`);--> statement-breakpoint

-- One cursor row per (account, kind). The old table had one row per account.
CREATE TABLE `sync_cursors` (
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`account_id`, `kind`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `sync_cursors_updated_idx` ON `sync_cursors` (`updated_at`);--> statement-breakpoint

-- Carry the existing Gmail cursors over before either old copy is dropped.
INSERT OR IGNORE INTO `sync_cursors` (`account_id`, `kind`, `value`, `updated_at`)
SELECT `account_id`, 'history', `history_id`, `updated_at` FROM `history_cursors`;--> statement-breakpoint
INSERT OR IGNORE INTO `sync_cursors` (`account_id`, `kind`, `value`, `updated_at`)
SELECT `id`, 'history', `history_id`, unixepoch() * 1000 FROM `accounts` WHERE `history_id` IS NOT NULL;--> statement-breakpoint

DROP TABLE `history_cursors`;--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `history_id`;
