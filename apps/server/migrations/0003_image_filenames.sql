-- Repair names of already converted images without reprocessing or moving objects.
-- rtrim stops at the last dot because its character set contains every non-dot
-- character of the filename. A leading dot alone is not an extension.
UPDATE images
SET name = substr(
  CASE WHEN length(rtrim(name, replace(name, '.', ''))) > 1
    THEN substr(name, 1, length(rtrim(name, replace(name, '.', ''))) - 1)
    ELSE name
  END, 1, 119 - length(format)
) || '.' || format,
access_version = access_version + 1
WHERE processing_status = 'completed' AND format IN ('jpg', 'png', 'webp')
  AND lower(substr(name, -length(format) - 1)) <> '.' || format
  AND NOT (format = 'jpg' AND lower(substr(name, -5)) = '.jpeg');
