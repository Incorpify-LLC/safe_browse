-- Add TOTP authenticator secret to parents table
-- base32-encoded 20-byte secret stored here; NULL = TOTP not configured
ALTER TABLE parents ADD COLUMN totp_secret TEXT;
