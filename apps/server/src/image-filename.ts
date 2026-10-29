import { extname } from 'node:path';

export function imageFilename(name: string, format: string) {
  const suffix = extname(name);
  if (
    suffix.toLowerCase() === `.${format}` ||
    (format === 'jpg' && suffix.toLowerCase() === '.jpeg')
  )
    return name;
  const stem = suffix ? name.slice(0, -suffix.length) : name;
  return `${stem.slice(0, 119 - format.length)}.${format}`;
}
