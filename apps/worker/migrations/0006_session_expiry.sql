-- Parent session expiry.
--
-- Before this migration `parents.session_token` had no lifetime: a token stayed
-- valid until the parent logged in again or logged out explicitly. In the
-- multi-tenant SaaS deployment that means a leaked or stolen token granted
-- permanent access to another family's household.
--
-- Both columns are NULL for sessions issued before this migration. Session
-- validation treats NULL as expired, so every existing session is invalidated
-- once — parents sign in again with their PIN, which is the intended trade.
ALTER TABLE parents ADD COLUMN session_expires_at TEXT;
ALTER TABLE parents ADD COLUMN session_last_used_at TEXT;
