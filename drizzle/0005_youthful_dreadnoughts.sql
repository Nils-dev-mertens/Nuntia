ALTER TABLE `accounts` ADD `default_strip_quoted_history` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `default_strip_greeting` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `default_strip_signature` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `sender_profiles` ADD `use_account_parsing_defaults` integer DEFAULT false NOT NULL;