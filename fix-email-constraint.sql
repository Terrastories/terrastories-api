-- Fix email constraint to allow same email in different communities
-- Drop the global email unique constraint and create a composite one

-- Drop the existing unique constraint on email
DROP INDEX IF EXISTS `users_email_unique`;

-- Create composite unique constraint on (email, community_id)
CREATE UNIQUE INDEX `users_email_community_unique` ON `users` (`email`, `community_id`);