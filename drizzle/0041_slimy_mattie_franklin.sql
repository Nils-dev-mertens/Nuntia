ALTER TABLE `reply_styles` ADD `is_default` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- Styles created before the flag existed still need a fallback. Pick the oldest
-- per person; they can choose another with "Make default".
UPDATE `reply_styles`
SET `is_default` = 1
WHERE `id` IN (
  SELECT `id`
  FROM (
    SELECT
      `id`,
      row_number() OVER (PARTITION BY `user_id` ORDER BY `created_at`, `id`) AS `rn`
    FROM `reply_styles`
  )
  WHERE `rn` = 1
);