import { useEffect, useState } from 'react';
import type { ImageInfo } from '../../../packages/shared/src/index';

export function useImageSource(image: Partial<ImageInfo>, thumbnail = false) {
  const original =
    (thumbnail ? image.thumbnailUrl : image.url) ?? `${thumbnail ? '/t/' : '/i/'}${image.id}`;
  const expiresAt = thumbnail ? image.thumbnailUrlExpiresAt : image.urlExpiresAt;
  const logical = image.id
    ? `${thumbnail ? '/t/' : '/i/'}${image.id}`
    : ((thumbnail ? image.logicalThumbnailUrl : image.logicalUrl) ?? original);
  const direct =
    !!expiresAt ||
    (/^https?:/.test(original) && new URL(original).searchParams.has('X-Amz-Signature'));
  const [fallback, setFallback] = useState(false),
    [failed, setFailed] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    setFallback(false);
    setFailed(false);
    setRevision(0);
  }, [original, expiresAt]);
  useEffect(() => {
    if (!expiresAt) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setFallback(true);
      return;
    }
    const timer = setTimeout(() => setFallback(true), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const useLogical = fallback || (!!expiresAt && expiresAt <= Date.now());
  const source = useLogical ? logical : original;
  return {
    source:
      revision && (!direct || useLogical)
        ? source + (source.includes('?') ? '&' : '?') + 'previewRetry=' + revision
        : source,
    direct,
    failed,
    logical,
    useLogical,
    onError: () => {
      if (direct && !useLogical) setFallback(true);
      else setFailed(true);
    },
    retry: () => {
      setFailed(false);
      if (direct) setFallback(true);
      setRevision((value) => value + 1);
    },
  };
}
