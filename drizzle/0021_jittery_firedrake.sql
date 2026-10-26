CREATE TABLE `form_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`response_id` text NOT NULL,
	`question_id` text NOT NULL,
	`value_text` text,
	`value_number` integer,
	`value_choices_json` text,
	FOREIGN KEY (`response_id`) REFERENCES `form_responses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `form_questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `form_answers_response_question_idx` ON `form_answers` (`response_id`,`question_id`);--> statement-breakpoint
CREATE TABLE `form_audience` (
	`form_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`form_id`, `user_id`),
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `form_participation` (
	`form_id` text NOT NULL,
	`user_id` text NOT NULL,
	`shown_at` integer,
	`dismissed_at` integer,
	`submitted_at` integer,
	PRIMARY KEY(`form_id`, `user_id`),
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `form_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`key` text NOT NULL,
	`position` integer NOT NULL,
	`type` text NOT NULL,
	`prompt` text NOT NULL,
	`help` text,
	`required` integer DEFAULT false NOT NULL,
	`options_json` text,
	`scale_low_label` text,
	`scale_high_label` text,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `form_questions_form_key_idx` ON `form_questions` (`form_id`,`key`);--> statement-breakpoint
CREATE INDEX `form_questions_form_position_idx` ON `form_questions` (`form_id`,`position`);--> statement-breakpoint
CREATE TABLE `form_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`user_id` text NOT NULL,
	`submitted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `form_responses_form_user_idx` ON `form_responses` (`form_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `form_responses_form_idx` ON `form_responses` (`form_id`,`submitted_at`);--> statement-breakpoint
CREATE TABLE `forms` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`audience` text DEFAULT 'all' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`published_at` integer,
	`closed_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `forms_status_idx` ON `forms` (`status`,`created_at`);