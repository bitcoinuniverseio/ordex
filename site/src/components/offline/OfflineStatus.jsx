import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';

export function OfflineStatus() {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Register Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      style="background: var(--color-warning-bg); border-bottom: 1px solid var(--color-warning); padding: 0.5rem 1rem; text-align: center; font-size: 0.85rem; font-weight: 600; color: var(--color-warning);"
      role="status"
    >
      📶 You are currently offline. Full documentation, local search, mock playground, and Protocol Lab remain available locally. Connected gateway queries and live assistant requests are paused.
    </div>
  );
}
