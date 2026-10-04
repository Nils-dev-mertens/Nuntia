CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`refresh_token_encrypted` text NOT NULL,
	`access_token_expires_at` integer,
	`scopes` text,
	`history_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_email_idx` ON `accounts` (`email`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`gmail_attachment_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`is_inline` integer DEFAULT false NOT NULL,
	`local_path` text,
	`content_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_message_gmail_idx` ON `attachments` (`message_id`,`gmail_attachment_id`);--> statement-breakpoint
CREATE INDEX `attachments_conversation_idx` ON `attachments` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`gmail_thread_id` text NOT NULL,
	`subject` text NOT NULL,
	`participants` text DEFAULT '[]' NOT NULL,
	`state` text DEFAULT 'informational' NOT NULL,
	`awaiting_reply` integer DEFAULT false NOT NULL,
	`topic` text,
	`goal` text,
	`importance` integer DEFAULT 5 NOT NULL,
	`urgency` integer DEFAULT 5 NOT NULL,
	`requires_reply` integer DEFAULT false NOT NULL,
	`intent` text DEFAULT 'unknown' NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`attachment_count` integer DEFAULT 0 NOT NULL,
	`is_starred` integer DEFAULT false NOT NULL,
	`is_muted` integer DEFAULT false NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`last_message_at` integer NOT NULL,
	`decided_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_account_thread_idx` ON `conversations` (`account_id`,`gmail_thread_id`);--> statement-breakpoint
CREATE INDEX `conversations_state_idx` ON `conversations` (`account_id`,`state`);--> statement-breakpoint
CREATE INDEX `conversations_last_message_idx` ON `conversations` (`last_message_at`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`provider` text DEFAULT 'llm' NOT NULL,
	`model` text,
	`state` text NOT NULL,
	`importance` integer NOT NULL,
	`urgency` integer NOT NULL,
	`requires_reply` integer NOT NULL,
	`intent` text NOT NULL,
	`topic` text,
	`reasoning` text,
	`decided_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `decisions_conversation_idx` ON `decisions` (`conversation_id`,`decided_at`);--> statement-breakpoint
CREATE TABLE `history_cursors` (
	`account_id` text PRIMARY KEY NOT NULL,
	`history_id` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `history_cursors_updated_idx` ON `history_cursors` (`updated_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`gmail_message_id` text NOT NULL,
	`internet_message_id` text,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`cc` text DEFAULT '[]' NOT NULL,
	`subject` text NOT NULL,
	`snippet` text,
	`body_text` text,
	`body_html` text,
	`signature_text` text,
	`sent_at` integer NOT NULL,
	`is_from_account_owner` integer DEFAULT false NOT NULL,
	`is_draft` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_gmail_idx` ON `messages` (`conversation_id`,`gmail_message_id`);--> statement-breakpoint
CREATE INDEX `messages_conversation_sent_idx` ON `messages` (`conversation_id`,`sent_at`);