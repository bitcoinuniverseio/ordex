import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

// OX-S12: registers the build's service worker at the site base and reports what is actually
// saved for offline use (asked from the worker: version and cached files). A new version waits
// until the reader chooses to reload; failures are shown, not swallowed. Offline, the banner
// says whether this build's pages are saved, instead of promising that everything works.

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

function askStatus(worker) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 3000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    worker.postMessage('ORDEX_SW_STATUS', [channel.port2]);
  });
}

export function OfflineStatus() {
  const [online, setOnline] = useState(true);
  const [sw, setSw] = useState({ state: 'unknown' });

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);

    if (!('serviceWorker' in navigator)) setSw({ state: 'unsupported' });
    else {
      const refresh = async (reg) => {
        if (reg.waiting && navigator.serviceWorker.controller) setSw((s) => ({ ...s, state: 'update-ready', reg }));
        const active = reg.active;
        if (!active) return;
        const status = await askStatus(active);
        if (status) setSw((s) => (s.state === 'update-ready' ? { ...s, status } : { state: status.cached === status.total ? 'saved' : 'partial', status, reg }));
      };
      navigator.serviceWorker
        .register(`${BASE}/sw.js`, { scope: `${BASE}/` })
        .then((reg) => {
          setSw({ state: reg.active ? 'checking' : 'installing', reg });
          reg.addEventListener('updatefound', () => {
            const worker = reg.installing;
            worker?.addEventListener('statechange', () => {
              if (worker.state === 'installed') refresh(reg);
              if (worker.state === 'redundant' && !reg.active) setSw({ state: 'failed', error: 'Saving the pages for offline use failed.' });
            });
          });
          navigator.serviceWorker.ready.then(refresh);
        })
        .catch((err) => setSw({ state: 'failed', error: String(err?.message || err) }));
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded || !window.__ordexUpdateRequested) return;
        reloaded = true;
        window.location.reload();
      });
    }
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const update = () => {
    window.__ordexUpdateRequested = true;
    sw.reg?.waiting?.postMessage('ORDEX_SW_SKIP_WAITING');
  };

  const bar = 'padding: 0.5rem 1rem; text-align: center; font-size: 0.85rem; font-weight: 600; border-bottom: 1px solid var(--color-border);';
  const saved = sw.state === 'saved' || sw.state === 'update-ready';

  return (
    <div role="status" aria-live="polite" data-offline-state={sw.state}>
      {!online && (
        <div style={`${bar} background: var(--color-warning-bg); color: var(--color-text-primary);`}>
          You are offline.{' '}
          {saved
            ? `This build's pages, search and verifiers are saved (${sw.status?.cached} files). Gateway, docs service and Ask requests wait until you are back online.`
            : 'This site is not saved for offline use in this browser, so only pages already open will work.'}
        </div>
      )}
      {sw.state === 'update-ready' && (
        <div style={`${bar} background: var(--color-bg-subtle);`}>
          A new version of these pages is ready.{' '}
          <button type="button" class="btn btn-secondary" style="min-height: 28px; font-size: 0.8rem;" onClick={update}>
            Reload to update
          </button>
        </div>
      )}
      {sw.state === 'failed' && online && <div class="ox-sr-only">Offline copy unavailable: {sw.error}</div>}
    </div>
  );
}
