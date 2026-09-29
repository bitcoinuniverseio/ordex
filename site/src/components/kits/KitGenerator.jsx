import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import JSZip from 'jszip';
import { KIT_CAPABILITIES, KIT_MODES, KIT_RUNTIMES, createKitZip, generateKit, kitName, validateKitOptions, verifyKitZip } from '../../lib/kits/generator';
import { journeyStore } from '../../lib/session/journey-store';
import { NETWORKS } from '../../lib/session/journey-schema';
import { recordToolEvidence, SOURCE_BUILD } from '../../lib/session/evidence';
import { sha256Bytes } from '../../lib/browser/node-crypto.mjs';
import { inputDigest } from '../../lib/lab-report.mjs';

// OX-S06: the page collects the choices, generates the kit with the pure generator in
// site/src/lib/kits/generator.ts, reads the archive back to confirm every file, then starts
// the download and reports the file count, size and SHA-256. The SDK, vectors and pinned
// lockfile entries (site/src/data/kitAssets.json) load only when a kit is generated.

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function KitGenerator() {
  const [runtime, setRuntime] = useState('node');
  const [capabilities, setCapabilities] = useState(['asks', 'events']);
  const [mode, setMode] = useState('offline');
  const [network, setNetwork] = useState('mainnet');
  const [gatewayOrigin, setGatewayOrigin] = useState('');
  const [phase, setPhase] = useState('idle');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const urlRef = useRef(null);

  // Start from the network and gateway chosen in Settings (OX-S03); the page never writes them.
  useEffect(() => {
    let live = true;
    journeyStore
      .getSettings()
      .then((s) => {
        if (!live) return;
        setNetwork(s.network);
        setGatewayOrigin(s.gatewayOrigin || '');
      })
      .catch(() => {});
    return () => {
      live = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const options = { runtime, capabilities: KIT_CAPABILITIES.map((c) => c.id).filter((id) => capabilities.includes(id)), mode, network, gatewayOrigin, revision: SOURCE_BUILD };
  const problems = validateKitOptions(options);

  const toggleCap = (id) => setCapabilities((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));

  const generate = async () => {
    if (problems.length) return;
    setError('');
    setResult(null);
    try {
      setPhase('loading');
      const assets = (await import('../../data/kitAssets.json')).default;
      setPhase('generating');
      const { name, files } = generateKit(options, assets);
      const bytes = await createKitZip(name, files, JSZip);
      const mismatches = await verifyKitZip(name, files, bytes, JSZip);
      if (mismatches.length) throw new Error(`The archive did not match the generated files (${mismatches.slice(0, 3).join(', ')}). Nothing was downloaded.`);
      const sha256 = hex(sha256Bytes(bytes));
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      urlRef.current = url;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      const summary = { name, fileName: `${name}.zip`, files: files.map((f) => f.path), size: bytes.length, sha256, sdk: `${assets.sdk.name}@${assets.sdk.version}`, url };
      setResult(summary);
      setPhase('done');
      const digest = inputDigest(options);
      for (const cap of KIT_CAPABILITIES.filter((c) => options.capabilities.includes(c.id))) {
        recordToolEvidence({ tool: 'kits', operation: `kit:${cap.family}`, state: 'passed', evidenceClass: 'Deterministic example', inputDigest: digest, artifactDigests: [sha256] });
      }
    } catch (err) {
      setPhase('failed');
      setError(err?.message || String(err));
    }
  };

  const busy = phase === 'loading' || phase === 'generating';
  const fieldset = 'border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.75rem 1rem; margin: 0; min-width: 0;';
  const legend = 'font-weight: 700; font-size: 0.95rem; padding: 0 0.25rem;';
  const hint = 'font-size: 0.8rem; color: var(--color-text-secondary);';

  return (
    <div class="kit-generator-container panel" style="padding: 1.5rem; display: flex; flex-direction: column; gap: 1.25rem;">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem;">
        <fieldset style={fieldset}>
          <legend style={legend}>1. Runtime</legend>
          {KIT_RUNTIMES.map((r) => (
            <label key={r.id} style="display: flex; gap: 0.5rem; align-items: flex-start; padding: 0.4rem 0; cursor: pointer;">
              <input type="radio" name="kit_runtime" value={r.id} checked={runtime === r.id} onChange={() => setRuntime(r.id)} style="margin-top: 0.25rem;" />
              <span>
                <span style="display: block; font-weight: 600; font-size: 0.9rem;">{r.label}</span>
                <span style={hint}>{r.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset style={fieldset}>
          <legend style={legend}>2. Capabilities</legend>
          {KIT_CAPABILITIES.map((c) => (
            <label key={c.id} style="display: flex; gap: 0.5rem; align-items: center; padding: 0.3rem 0; font-size: 0.875rem; cursor: pointer;">
              <input type="checkbox" checked={capabilities.includes(c.id)} onChange={() => toggleCap(c.id)} />
              <span>{c.label}</span>
            </label>
          ))}
          <p style={`${hint} margin: 0.5rem 0 0;`}>Each one runs its checked-in conformance vectors through the SDK as the kit's own tests.</p>
        </fieldset>

        <fieldset style={fieldset}>
          <legend style={legend}>3. Mode</legend>
          {KIT_MODES.map((m) => (
            <label key={m.id} style="display: flex; gap: 0.5rem; align-items: flex-start; padding: 0.4rem 0; cursor: pointer;">
              <input type="radio" name="kit_mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} style="margin-top: 0.25rem;" />
              <span>
                <span style="display: block; font-weight: 600; font-size: 0.9rem;">{m.label}</span>
                <span style={hint}>{m.description}</span>
              </span>
            </label>
          ))}
          {mode === 'gateway' && (
            <div style="display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.5rem;">
              <label style="font-size: 0.85rem; font-weight: 600;" for="kit-gateway-origin">
                Gateway origin
              </label>
              <input id="kit-gateway-origin" type="url" value={gatewayOrigin} onInput={(e) => setGatewayOrigin(e.currentTarget.value)} placeholder="https://gateway.example" autocomplete="off" spellcheck={false} style="padding: 0.4rem; font-family: var(--font-mono); font-size: 0.85rem;" />
              <label style="font-size: 0.85rem; font-weight: 600;" for="kit-network">
                Network the gateway must serve
              </label>
              <select id="kit-network" value={network} onChange={(e) => setNetwork(e.currentTarget.value)} style="padding: 0.4rem;">
                {NETWORKS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <p style={`${hint} margin: 0;`}>The kit reads this gateway only. It carries no credentials, and it refuses a gateway on another network.</p>
            </div>
          )}
        </fieldset>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 1rem; align-items: center;">
        <button type="button" class="btn btn-primary" onClick={generate} disabled={busy || problems.length > 0} aria-describedby="kit-status">
          {phase === 'loading' ? 'Loading the SDK and vectors...' : phase === 'generating' ? 'Building the archive...' : `Download ${kitName(options)}.zip`}
        </button>
        <span style={hint}>Source {SOURCE_BUILD}. Nothing leaves your browser.</span>
      </div>

      {problems.length > 0 && (
        <ul id="kit-status" role="alert" style="margin: 0; padding-left: 1.2rem; color: var(--color-danger, #a61e4d); font-size: 0.875rem;">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {problems.length === 0 && (
        <div id="kit-status" role="status" aria-live="polite" style="font-size: 0.9rem;">
          {phase === 'done' && result && (
            <div style="display: flex; flex-direction: column; gap: 0.35rem;">
              <strong>
                Download started: {result.fileName}, {result.files.length} files, {(result.size / 1024).toFixed(1)} KiB.
              </strong>
              <span style={hint}>
                SHA-256 <code style="word-break: break-all;">{result.sha256}</code>. The archive was read back and every file matched before the download.{' '}
                <a href={result.url} download={result.fileName}>
                  Download again
                </a>
              </span>
              <span style={hint}>
                Next: unzip, then run <code>npm ci</code>, <code>npm test</code> and <code>npm start</code> with Node.js 24.19.0. The SDK ({result.sdk}) is vendored in the kit.
              </span>
              <details>
                <summary style="cursor: pointer;">Files in the kit</summary>
                <ul style="margin: 0.5rem 0 0; padding-left: 1.2rem; font-family: var(--font-mono); font-size: 0.8rem; max-height: 16rem; overflow: auto;">
                  {result.files.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </div>
      )}
      {phase === 'failed' && (
        <p role="alert" style="margin: 0; color: var(--color-danger, #a61e4d); font-size: 0.9rem;">
          The kit was not generated: {error}
        </p>
      )}
    </div>
  );
}
