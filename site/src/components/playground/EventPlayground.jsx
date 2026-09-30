import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import vectorFamilies from '../../data/vectorFamilies.json';
import { signWebhookDelivery, verifyWebhookSignature, validateOrdexEvent } from '../../../../verifier/events.js';
import { createStreamState, ingestEvent, runSse, runWebSocket, streamUrls } from '../../lib/events/event-stream.mjs';
import { journeyStore, DEFAULT_SETTINGS } from '../../lib/session/journey-store';
import { recordToolEvidence } from '../../lib/session/evidence';
import { tabKeyHandler, tabProps, tabPanelProps } from '../../lib/a11y/tabs.js';

// Deterministic fixtures: the accepted ordex-event/v1 envelopes from the conformance vectors.
const FIXTURES = vectorFamilies.events.cases
  .filter((c) => c.variant === 'event' && c.case.expected.ok === true)
  .map((c) => c.case.event);

const TABS = ['example', 'sse', 'ws', 'webhook'];
const TAB_LABELS = { example: 'Deterministic example', sse: 'SSE stream', ws: 'WebSocket', webhook: 'Webhook signature' };

const cursorKey = (origin, network, transport) => `ordex.events.cursor:${origin}:${network}:${transport}`;
const readCursor = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeCursor = (key, value) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // storage unavailable: resumption lasts for this page only
  }
};

function EventTable({ events }) {
  if (!events.length) return <p style="font-size: 0.85rem; color: var(--color-text-secondary);">No events yet.</p>;
  return (
    <div style="overflow-x: auto; max-height: 400px; overflow-y: auto;">
      <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
        <caption class="ox-sr-only">Received events, newest first</caption>
        <thead>
          <tr style="border-bottom: 2px solid var(--color-border); text-align: left;">
            <th scope="col" style="padding: 0.5rem;">Seq</th>
            <th scope="col" style="padding: 0.5rem;">Type</th>
            <th scope="col" style="padding: 0.5rem;">Status</th>
            <th scope="col" style="padding: 0.5rem;">Event id</th>
            <th scope="col" style="padding: 0.5rem;">Observed</th>
          </tr>
        </thead>
        <tbody>
          {events.map((ev) => (
            <tr key={ev.id} style="border-bottom: 1px solid var(--color-border); font-family: var(--font-mono);">
              <td style="padding: 0.5rem;">{ev.sequence}{ev._outOfOrder ? ' (out of order)' : ''}</td>
              <td style="padding: 0.5rem;">{ev.type}</td>
              <td style="padding: 0.5rem;">{ev.status === 'reverted' ? `reverted ${ev.revertedEventId || ''}` : ev.status}</td>
              <td style="padding: 0.5rem; word-break: break-all;">{ev.id}</td>
              <td style="padding: 0.5rem;">{ev.observedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// OX-S05: fixtures are labelled as examples and replay deterministically across pause; the
// connected transports read the configured gateway's SSE and WebSocket streams with
// validation, deduplication, cursor resumption and backoff; webhook checks use the events
// verifier with an explicit nowSeconds and the exact body. The secret is never stored.
export function EventPlayground() {
  const [tab, setTab] = useState('example');
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [stream, setStream] = useState(createStreamState());
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [connection, setConnection] = useState(null);
  const [lastIssue, setLastIssue] = useState(null);
  const abortRef = useRef(null);
  const streamRef = useRef(stream);
  const recordedRef = useRef(new Set());

  const [secret, setSecret] = useState('');
  const [body, setBody] = useState('{"ok":true}');
  const [header, setHeader] = useState('');
  const [nowSeconds, setNowSeconds] = useState(() => String(Math.floor(Date.now() / 1000)));
  const [tolerance, setTolerance] = useState('300');
  const [verdict, setVerdict] = useState(null);

  useEffect(() => {
    let live = true;
    const load = () => journeyStore.getSettings().then((s) => live && setSettings(s)).catch(() => {});
    load();
    const off = journeyStore.subscribe((e) => e.type === 'settings' && load());
    return () => {
      live = false;
      off();
      abortRef.current?.abort();
    };
  }, []);

  const resetStream = () => {
    abortRef.current?.abort();
    const fresh = createStreamState();
    streamRef.current = fresh;
    setStream(fresh);
    setConnection(null);
    setLastIssue(null);
    setPosition(0);
    setPlaying(false);
  };

  const selectTab = (t) => {
    if (t !== tab) resetStream();
    setTab(t);
  };

  // Deterministic example playback keeps its position across pause.
  useEffect(() => {
    if (tab !== 'example' || !playing) return undefined;
    if (position >= FIXTURES.length) {
      setPlaying(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      const r = ingestEvent(streamRef.current, FIXTURES[position], validateOrdexEvent);
      streamRef.current = r.state;
      setStream(r.state);
      setPosition((p) => p + 1);
    }, 800);
    return () => clearTimeout(timer);
  }, [tab, playing, position]);

  const process = (msg) => {
    const r = ingestEvent(streamRef.current, msg.data, validateOrdexEvent, msg.id, msg.cursor ?? null);
    streamRef.current = r.state;
    setStream(r.state);
    if (r.outcome === 'invalid') setLastIssue(r.detail);
    const counted = r.outcome === 'accepted' || r.outcome === 'out-of-order' || r.outcome === 'duplicate';
    if (counted) writeCursor(cursorKey(settings.gatewayOrigin, settings.network, tab), r.state.cursor);
    if (r.outcome === 'accepted' && !recordedRef.current.has(tab)) {
      recordedRef.current.add(tab);
      recordToolEvidence({
        tool: 'events',
        operation: `events:stream:${tab}`,
        state: 'passed',
        reason: 'Received and validated an ordex-event/v1 envelope from the configured gateway.',
        evidenceClass: 'Gateway observation'
      });
    }
    // Only a newly processed event moves the transport resume cursor; a duplicate carries an
    // older id and must not send the stream back to it.
    return r.outcome === 'accepted' || r.outcome === 'out-of-order';
  };

  const connect = () => {
    if (!settings.gatewayOrigin) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const key = cursorKey(settings.gatewayOrigin, settings.network, tab);
    const urls = streamUrls(settings.gatewayOrigin, { network: settings.network });
    const common = { onMessage: async (m) => process(m), onStatus: setConnection, signal: controller.signal };
    const cursor = readCursor(key);
    if (tab === 'sse') runSse({ url: urls.sse, lastEventId: cursor, ...common });
    else runWebSocket({ url: urls.ws, cursor, filters: { network: settings.network }, ...common });
  };

  const disconnect = () => abortRef.current?.abort();

  const resync = () => {
    writeCursor(cursorKey(settings.gatewayOrigin, settings.network, tab), null);
    resetStream();
  };

  const signNow = () => {
    try {
      const ts = Math.floor(Date.now() / 1000);
      setHeader(signWebhookDelivery({ secret, timestamp: ts, deliveryId: `dlv_${ts}`, body }));
      setNowSeconds(String(ts));
      setVerdict(null);
    } catch (err) {
      setVerdict({ ok: false, code: 'SIGNING_INPUT_INVALID', reason: err.message });
    }
  };

  const verify = () => {
    const now = Number(nowSeconds);
    const tol = Number(tolerance);
    if (!Number.isInteger(now) || !Number.isInteger(tol) || tol < 0) {
      setVerdict({ ok: false, code: 'INPUT_INVALID', reason: 'nowSeconds and tolerance must be whole numbers of seconds.' });
      return;
    }
    const result = verifyWebhookSignature({ header, secret, body, nowSeconds: now, toleranceSeconds: tol });
    setVerdict(result);
    recordToolEvidence({
      tool: 'events',
      operation: 'events:webhook',
      state: result.ok ? 'accepted' : 'refused',
      code: result.ok ? null : result.code,
      reason: result.ok ? 'The signature matches the secret, delivery id and body within the time window.' : result.reason,
      evidenceClass: 'Protocol verification'
    });
  };

  const onTabKey = tabKeyHandler(TABS, tab, selectTab, 'events');
  const connected = tab === 'sse' || tab === 'ws';
  const cursorNow = stream.cursor || (connected && settings.gatewayOrigin ? readCursor(cursorKey(settings.gatewayOrigin, settings.network, tab)) : null);

  return (
    <div class="event-playground-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      <div class="panel" style="padding: 1rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem;">
          <h3 style="margin: 0; font-size: 1.1rem;">Events and webhooks</h3>
          <span style="font-size: 0.8rem; color: var(--color-text-secondary);">spec/asyncapi.json, ordex-event/v1</span>
        </div>
        <div role="tablist" aria-label="Event transport" style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          {TABS.map((t) => (
            <button key={t} {...tabProps('events', t, tab, selectTab, onTabKey)} class={`btn ${tab === t ? 'btn-primary' : 'btn-outline'}`} style="font-size: 0.85rem;">
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {tab === 'example' && (
        <div {...tabPanelProps('events', 'example')} class="panel">
          <div class="panel-header" style="flex-wrap: wrap; gap: 0.5rem;">
            <div>
              <h3 style="margin: 0; font-size: 1.1rem;">Deterministic example replay</h3>
              <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
                {FIXTURES.length} fixed envelopes from the conformance vectors, validated as they play. This is an example, not a gateway stream.
              </p>
            </div>
            <div style="display: flex; gap: 0.5rem;">
              <button class="btn btn-primary" type="button" onClick={() => setPlaying(!playing)} disabled={position >= FIXTURES.length} aria-pressed={playing ? 'true' : 'false'}>
                {playing ? 'Pause' : position > 0 ? 'Resume' : 'Play'}
              </button>
              <button class="btn btn-outline" type="button" onClick={resetStream}>Reset</button>
            </div>
          </div>
          <p role="status" style="font-size: 0.85rem;">Played {position} of {FIXTURES.length}. Cursor: <code>{stream.cursor || 'none'}</code></p>
          <EventTable events={stream.events} />
        </div>
      )}

      {connected && (
        <div {...tabPanelProps('events', tab)} class="panel">
          <div class="panel-header" style="flex-wrap: wrap; gap: 0.5rem;">
            <div>
              <h3 style="margin: 0; font-size: 1.1rem;">{tab === 'sse' ? 'Server-sent events' : 'WebSocket'} from the configured gateway</h3>
              <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
                {settings.gatewayOrigin ? `${streamUrls(settings.gatewayOrigin).sse.replace('/stream', tab === 'sse' ? '/stream' : '/ws')} (network ${settings.network})` : 'No gateway origin is configured. Set one in the settings menu.'}
              </p>
            </div>
            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
              <button class="btn btn-primary" type="button" disabled={!settings.gatewayOrigin || (connection && connection.state !== 'closed' && connection.state !== 'cursor-expired')} onClick={connect}>Connect</button>
              <button class="btn btn-outline" type="button" disabled={!connection || connection.state === 'closed'} onClick={disconnect}>Disconnect</button>
              <button class="btn btn-outline" type="button" onClick={resync}>Forget cursor</button>
            </div>
          </div>
          <div role="status" aria-live="polite" style="font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.2rem;">
            <span>
              Connection: <strong>{connection?.state || 'not connected'}</strong>
              {connection?.state === 'waiting' && ` (retry ${connection.attempt} in ${Math.round(connection.delayMs / 1000)} s: ${connection.error})`}
            </span>
            {connection?.state === 'cursor-expired' && <span style="color: var(--color-danger);">The gateway no longer holds events after the saved cursor. Forget the cursor to resync from the current position; missed events are not invented.</span>}
            <span>Resume cursor (advanced only after an event is processed): <code>{cursorNow || 'none'}</code></span>
            <span>Accepted {stream.counts.accepted}, duplicates {stream.counts.duplicate}, invalid {stream.counts.invalid}, out of order {stream.counts.outOfOrder}</span>
            {lastIssue && <span style="color: var(--color-danger);">Last invalid message: {lastIssue}</span>}
          </div>
          <EventTable events={stream.events} />
        </div>
      )}

      {tab === 'webhook' && (
        <div {...tabPanelProps('events', 'webhook')} class="panel">
          <div class="panel-header">
            <div>
              <h3 style="margin: 0; font-size: 1.15rem;">Verify a webhook signature</h3>
              <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
                Runs verifier/events.js in this tab. Paste the exact body bytes you received; the secret stays in this page and is never saved.
              </p>
            </div>
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 1.5rem;">
            <div style="display: flex; flex-direction: column; gap: 0.75rem;">
              <label style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; font-weight: 600;">
                Subscription secret
                <input type="password" autocomplete="off" value={secret} onInput={(e) => { setSecret(e.currentTarget.value); setVerdict(null); }} style="font-family: var(--font-mono); padding: 0.4rem 0.6rem;" />
              </label>
              <label style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; font-weight: 600;">
                Raw body, exactly as received
                <textarea rows={4} spellcheck={false} value={body} onInput={(e) => { setBody(e.currentTarget.value); setVerdict(null); }} style="font-family: var(--font-mono); padding: 0.6rem;" />
              </label>
              <label style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; font-weight: 600;">
                X-Ordex-Signature header
                <input type="text" spellcheck={false} value={header} onInput={(e) => { setHeader(e.currentTarget.value); setVerdict(null); }} style="font-family: var(--font-mono); font-size: 0.8rem; padding: 0.4rem 0.6rem;" />
              </label>
              <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
                <label style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; font-weight: 600;">
                  nowSeconds
                  <input type="text" inputMode="numeric" value={nowSeconds} onInput={(e) => { setNowSeconds(e.currentTarget.value); setVerdict(null); }} style="font-family: var(--font-mono); padding: 0.4rem 0.6rem; width: 12ch;" />
                </label>
                <label style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; font-weight: 600;">
                  Tolerance (seconds)
                  <input type="text" inputMode="numeric" value={tolerance} onInput={(e) => { setTolerance(e.currentTarget.value); setVerdict(null); }} style="font-family: var(--font-mono); padding: 0.4rem 0.6rem; width: 8ch;" />
                </label>
              </div>
              <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
                <button class="btn btn-outline" type="button" onClick={signNow} disabled={!secret}>Sign this body now (test)</button>
                <button class="btn btn-primary" type="button" onClick={verify}>Verify signature</button>
              </div>
            </div>
            <div aria-live="polite">
              {!verdict ? (
                <p style="font-size: 0.9rem; color: var(--color-text-secondary);">Enter the delivery and verify it.</p>
              ) : (
                <div class="panel" style={{ borderColor: verdict.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>
                  <div style={{ fontWeight: 800, color: verdict.ok ? 'var(--color-success)' : 'var(--color-danger)', marginBottom: '0.5rem' }}>
                    {verdict.ok ? 'Signature valid' : `Refused: ${verdict.code}`}
                  </div>
                  <div style="font-size: 0.85rem;">
                    {verdict.ok ? 'The header matches this secret, delivery id and body digest within the tolerance window.' : verdict.reason}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
