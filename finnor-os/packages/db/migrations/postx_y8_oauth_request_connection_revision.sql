ALTER TABLE finnor_os.oauth_connection_requests
  ADD COLUMN IF NOT EXISTS connection_revision integer
  CHECK (connection_revision > 0);
