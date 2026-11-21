ALTER TABLE `messages` ADD `in_reply_to` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `reference_ids` text DEFAULT '[]' NOT NULL;