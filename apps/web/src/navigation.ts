import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

export function useUrlTab(allowed: readonly string[], fallback: string) {
  const [params, setParams] = useSearchParams();
  const value = params.get('tab') ?? fallback;
  const tab = allowed.includes(value) ? value : fallback;
  useEffect(() => {
    if (value !== tab) {
      const next = new URLSearchParams(params);
      next.set('tab', tab);
      next.delete('task');
      setParams(next, { replace: true });
    }
  }, [value, tab, params, setParams]);
  useEffect(() => {
    const button = document.querySelector<HTMLElement>('.workspace .tabs .active');
    const tabs = button?.parentElement;
    if (!button || !tabs) return;
    const reveal = () => {
      const item = button.getBoundingClientRect(),
        container = tabs.getBoundingClientRect();
      if (item.right > container.right) tabs.scrollLeft += item.right - container.right + 12;
      else if (item.left < container.left) tabs.scrollLeft -= container.left - item.left + 12;
    };
    const observer = new ResizeObserver(reveal);
    observer.observe(tabs);
    reveal();
    return () => observer.disconnect();
  }, [tab]);
  return [
    tab,
    (nextTab: string) => {
      const next = new URLSearchParams(params);
      next.set('tab', nextTab);
      next.delete('task');
      setParams(next);
    },
  ] as const;
}
