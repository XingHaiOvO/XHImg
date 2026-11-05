ALTER TABLE random_endpoints ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image','video','mixed'));
