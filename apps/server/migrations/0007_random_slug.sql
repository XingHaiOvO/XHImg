ALTER TABLE random_endpoints ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX random_endpoint_slug ON random_endpoints(slug) WHERE slug IS NOT NULL;
