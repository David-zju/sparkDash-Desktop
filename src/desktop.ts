declare global {
  interface Window {
    sparkDesktop?: {
      isDesktop: boolean;
      platform: string;
      listSshAliases(): Promise<{ aliases: string[]; warnings: string[] }>;
      getPreference(key: string): string | null;
      setPreference(key: string, value: string): void;
      onPreferenceChange(listener: (key: string, value: string) => void): () => void;
    };
  }
}

export const isDesktop = typeof window !== 'undefined' && Boolean(window.sparkDesktop?.isDesktop);
export const preferences = {
  getItem(key: string): string | null {
    return isDesktop ? window.sparkDesktop!.getPreference(key) : localStorage.getItem(key);
  },
  setItem(key: string, value: string) {
    if (isDesktop) window.sparkDesktop!.setPreference(key, value);
    else localStorage.setItem(key, value);
  },
};
