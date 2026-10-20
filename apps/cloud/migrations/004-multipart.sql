ALTER TABLE cloud_uploads ADD COLUMN part_bytes bigint NOT NULL DEFAULT 8388608;
CREATE TABLE cloud_upload_parts (
  upload_id uuid NOT NULL REFERENCES cloud_uploads(id),
  number integer NOT NULL CHECK(number BETWEEN 1 AND 10000),
  md5 text NOT NULL,
  PRIMARY KEY(upload_id,number)
);
