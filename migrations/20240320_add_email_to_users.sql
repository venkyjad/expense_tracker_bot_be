-- Add email column to users table
ALTER TABLE users
ADD COLUMN email VARCHAR(255);

-- Add index for email lookups
CREATE INDEX idx_users_email ON users(email);

-- Add comment to the column
COMMENT ON COLUMN users.email IS 'User email address for notifications and account recovery'; 