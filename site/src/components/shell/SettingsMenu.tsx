import type { JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { VersionEnvironmentController } from '../experience/VersionEnvironmentController.js';
import { journeyStore, DEFAULT_SETTINGS, type UserSettings, type StorageState } from '../../lib/session/journey-store.js';
import { SOURCE_BUILD } from '../../lib/session/evidence.js';

// OX-S03: the shared network, gateway, mode and protocol settings on every documentation
// page, so the playgrounds, Gateway Doctor and missions all read the same context.
export function SettingsMenu(): JSX.Element {
  const [settings, setSettings] = useState<UserSettings>({ ...DEFAULT_SETTINGS });
  const [storageState, setStorageState] = useState<StorageState>(journeyStore.storageState);

  useEffect(() => {
    let live = true;
    const load = () => journeyStore.getSettings().then((s) => live && setSettings(s)).catch(() => {});
    load();
    const off = journeyStore.subscribe((e) => {
      if (e.type === 'settings') load();
      if (e.type === 'status') setStorageState(e.state);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  const onChange = async (patch: Partial<UserSettings>) => {
    try {
      setSettings(await journeyStore.saveSettings(patch));
    } catch {
      setStorageState(journeyStore.storageState);
    }
  };

  return <VersionEnvironmentController settings={settings} onChange={onChange} buildRevision={SOURCE_BUILD} storageState={storageState} />;
}
