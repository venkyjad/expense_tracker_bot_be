-- Remove email index
DROP INDEX IF EXISTS idx_users_email;

-- Remove email column
ALTER TABLE users
DROP COLUMN IF EXISTS email; 