import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useData } from './api';

type SiteSettings = {
  title: string;
  description: string;
  logoUrl: string;
  homeBackgroundUrl: string;
};

const SiteSettingsContext = createContext<SiteSettings | undefined>(undefined);

export function SiteSettingsProvider({ children }: { children: ReactNode }) {
  const { data, reload } = useData<SiteSettings>('public/settings');
  useEffect(() => {
    const changed = () => void reload();
    window.addEventListener('site-settings', changed);
    return () => window.removeEventListener('site-settings', changed);
  }, [reload]);
  return <SiteSettingsContext.Provider value={data}>{children}</SiteSettingsContext.Provider>;
}

export function useSiteSettings() {
  return useContext(SiteSettingsContext);
}
