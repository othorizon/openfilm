CREATE TABLE cloud_blobs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES cloud_users(id),
  object_key text NOT NULL UNIQUE,
  size bigint NOT NULL CHECK (size > 0),
  sha256 text NOT NULL,
  etag text NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE cloud_items (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES cloud_users(id),
  blob_id uuid NOT NULL REFERENCES cloud_blobs(id),
  kind text NOT NULL CHECK (kind IN ('asset','snapshot','result')),
  name text NOT NULL,
  media_type text NOT NULL,
  content_type text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  project_id text,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  withdrawn boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (visibility = 'private' OR kind = 'asset'),
  UNIQUE (blob_id, kind)
);
CREATE INDEX cloud_items_owner ON cloud_items(owner_id, kind, created_at);
CREATE INDEX cloud_items_public ON cloud_items(visibility, withdrawn);
CREATE TABLE cloud_uploads (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES cloud_users(id),
  request_id uuid NOT NULL,
  metadata jsonb NOT NULL,
  size bigint NOT NULL CHECK (size > 0),
  mode text NOT NULL DEFAULT 'single',
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','completed','cancelled','expired')),
  staging_key text NOT NULL,
  object_key text NOT NULL UNIQUE,
  upload_id text,
  item_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, request_id)
);
CREATE INDEX cloud_uploads_owner ON cloud_uploads(owner_id, state);
CREATE TABLE cloud_cleanup (
  object_key text PRIMARY KEY,
  upload_id text,
  after_at timestamptz NOT NULL DEFAULT now()
);
