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

    /* IMPLEMENTATION-HANDOFF [OX-S12]
     * Defect OX-S-D12; coverage OX-S-C1500..OX-S-C1505. Registration targets /sw.js even though Pages serves
     * /ordex/sw.js; all failures are swallowed and offline text claims unavailable resources are present.
     * 1. Register the OX-S12 versioned worker using the actual BASE_URL and scope, report
     * registration/install/update status and coordinate activation without dropping a working release.
     * 2. Derive offline availability from completed static manifest installation and verifier bundle readiness.
     * Pause connected operations explicitly in their consumers, retain retryable state, and never substitute
     * simulated success for a failed request.
     * 3. Test first visit, reload, offline revisit/direct route, partial install, failed update, reconnect and two
     * installed versions at both supported base paths. Use PROPOSED NEW tests/e2e/offline.test.js with real
     * service worker/cache assertions.
     * Dependencies: OX-S12 worker cache policy, OX-S07 verifiers, OX-S11 docs endpoints. Rollback registration and
     * worker namespace together; no deletion of unrelated caches.
     */
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
