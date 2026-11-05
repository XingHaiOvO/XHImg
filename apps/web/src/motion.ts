import { useLayoutEffect, useRef } from 'react';

export function animateEntrance(
  element: HTMLElement,
  keyframes: Keyframe[],
  duration: number,
  delay = 0,
) {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  if (preference.matches || typeof element.animate !== 'function') return;
  const animation = element.animate(keyframes, {
    duration,
    delay,
    fill: 'backwards',
    easing: getComputedStyle(element).getPropertyValue('--ease').trim() || 'ease-out',
  });
  const reduce = () => {
    if (preference.matches) animation.finish();
  };
  preference.addEventListener('change', reduce);
  const cleanup = () => preference.removeEventListener('change', reduce);
  void animation.finished.then(cleanup, cleanup);
  return animation;
}

export function useRouteEntrance<T extends HTMLElement>(pathname: string) {
  const content = useRef<T>(null);
  const previousPath = useRef(pathname);
  useLayoutEffect(() => {
    const changed = previousPath.current !== pathname;
    previousPath.current = pathname;
    if (!changed || !content.current) return;
    const animation = animateEntrance(
      content.current,
      [
        { opacity: 0.65, transform: 'translateY(6px)' },
        { opacity: 1, transform: 'none' },
      ],
      180,
    );
    return () => animation?.cancel();
  }, [pathname]);
  return content;
}
