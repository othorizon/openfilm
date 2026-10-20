CREATE TABLE cloud_users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  quota_bytes bigint NOT NULL DEFAULT 10000000000 CHECK (quota_bytes >= 0),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cloud_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cloud_sessions_user_id ON cloud_sessions(user_id);
CREATE INDEX cloud_sessions_expiry ON cloud_sessions(expires_at);
