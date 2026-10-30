-- Password brute-force lockout for merchant and admin login. Each password
-- check against an existing account reserves one attempt; reaching the limit
-- sets locked_until, and no password is checked for that account until it
-- passes. A successful login resets both columns. See auth/loginLockout.ts.

ALTER TABLE merchant_users
    ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN locked_until       TIMESTAMPTZ;

ALTER TABLE admin_users
    ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN locked_until       TIMESTAMPTZ;
