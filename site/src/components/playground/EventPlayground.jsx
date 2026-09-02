import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import channelsData from '../../data/channels.json';
import { signWebhookDelivery, verifyWebhookSignature } from '../../../../verifier/events.js';

export function EventPlayground() {
  const [activeChannel, setActiveChannel] = useState(channelsData[0]?.name || 'eventsStream');
  const [isStreaming, setIsStreaming] = useState(true);
  const [cursor, setCursor] = useState('ordex-event-001');
  const [eventsList, setEventsList] = useState([]);
  const [webhookSecret, setWebhookSecret] = useState('whsec_test_secret_32bytes_sample_123');
  const [webhookBody, setWebhookBody] = useState('{"event":"order.settled","orderId":"ord_01","priceSats":"100000"}');
  const [signedHeader, setSignedHeader] = useState('');
  const [verificationResult, setVerificationResult] = useState(null);

  // Simulated events generator
  useEffect(() => {
    let count = 1;
    const initialEvents = [
      { id: 'ordex-event-001', type: 'order.created', network: 'mainnet', sequence: 101, status: 'current', timestamp: new Date(Date.now() - 60000).toISOString(), payload: { orderId: 'ord_pub_98a72f', priceSats: '150000' } },
      { id: 'ordex-event-002', type: 'order.reserved', network: 'mainnet', sequence: 102, status: 'current', timestamp: new Date(Date.now() - 30000).toISOString(), payload: { orderId: 'ord_pub_98a72f', lockExpiresHeight: 890120 } }
    ];
    setEventsList(initialEvents);

    const interval = setInterval(() => {
      if (!isStreaming) return;
      count++;
      const eventTypes = ['order.created', 'order.reserved', 'order.settled', 'order.withdrawn', 'offer.published'];
      const randomType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
      const newEvent = {
        id: `ordex-event-00${count + 2}`,
        type: randomType,
        network: 'mainnet',
        sequence: 102 + count,
        status: 'current',
        timestamp: new Date().toISOString(),
        payload: {
          orderId: `ord_${Math.random().toString(16).slice(2, 10)}`,
          priceSats: `${Math.floor(Math.random() * 500000 + 10000)}`
        }
      };

      setEventsList((prev) => [newEvent, ...prev.slice(0, 19)]);
      setCursor(newEvent.id);
    }, 4000);

    return () => clearInterval(interval);
  }, [isStreaming]);

  // Generate initial signed webhook
  useEffect(() => {
    try {
      const header = signWebhookDelivery({
        secret: webhookSecret,
        timestamp: Math.floor(Date.now() / 1000),
        deliveryId: 'deliv_test_001',
        body: webhookBody
      });
      setSignedHeader(header);
    } catch (e) {}
  }, [webhookSecret, webhookBody]);

  const handleVerifyWebhook = () => {
    try {
      const result = verifyWebhookSignature({
        header: signedHeader,
        secret: webhookSecret,
        body: webhookBody,
        now: Math.floor(Date.now() / 1000)
      });
      setVerificationResult(result);
    } catch (err) {
      setVerificationResult({ ok: false, code: 'SIGNATURE_INVALID', reason: err.message });
    }
  };

  return (
    <div class="event-playground-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      {/* Channels Bar */}
      <div class="panel" style="padding: 1rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <h3 style="margin: 0; font-size: 1.1rem;">AsyncAPI Event & Webhook Channels</h3>
          <span style="font-size: 0.8rem; color: var(--color-text-muted);">spec/asyncapi.json</span>
        </div>
        <div style="display: flex; gap: 0.5rem;">
          {channelsData.map((ch) => (
            <button
              key={ch.name}
              class={`btn ${activeChannel === ch.name ? 'btn-primary' : 'btn-outline'}`}
              style="font-size: 0.85rem;"
              onClick={() => setActiveChannel(ch.name)}
            >
              {ch.name === 'eventsStream' ? '📡 SSE Stream' : ch.name === 'eventsSocket' ? '🔌 WebSocket' : '🔔 Signed Webhooks'}
            </button>
          ))}
        </div>
      </div>

      {activeChannel !== 'webhookDelivery' ? (
        /* Event Stream Simulator */
        <div class="panel">
          <div class="panel-header">
            <div>
              <h3 style="margin: 0; font-size: 1.15rem;">Live Orderbook Event Stream (SSE Simulator)</h3>
              <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
                Deterministic replay cursor: <code>{cursor}</code>
              </p>
            </div>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <button
                class={`btn ${isStreaming ? 'btn-outline' : 'btn-primary'}`}
                onClick={() => setIsStreaming(!isStreaming)}
              >
                {isStreaming ? '⏸ Pause Stream' : '▶ Resume Stream'}
              </button>
              <button
                class="btn btn-secondary"
                onClick={() => setEventsList([])}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Events Table */}
          <div style="overflow-x: auto; max-height: 400px; overflow-y: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
              <thead>
                <tr style="border-bottom: 2px solid var(--color-border); text-align: left;">
                  <th style="padding: 0.5rem;">Seq</th>
                  <th style="padding: 0.5rem;">Event ID</th>
                  <th style="padding: 0.5rem;">Type</th>
                  <th style="padding: 0.5rem;">Payload</th>
                  <th style="padding: 0.5rem;">Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {eventsList.map((ev) => (
                  <tr key={ev.id} style="border-bottom: 1px solid var(--color-border); font-family: var(--font-mono);">
                    <td style="padding: 0.5rem; color: var(--color-brand); font-weight: 700;">#{ev.sequence}</td>
                    <td style="padding: 0.5rem; color: var(--color-text-muted);">{ev.id}</td>
                    <td style="padding: 0.5rem;">
                      <span class="badge badge-verification">{ev.type}</span>
                    </td>
                    <td style="padding: 0.5rem;">
                      <code>{JSON.stringify(ev.payload)}</code>
                    </td>
                    <td style="padding: 0.5rem; color: var(--color-text-muted); font-size: 0.8em;">{ev.timestamp.slice(11, 19)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Webhook Signature Inspector */
        <div class="panel">
          <div class="panel-header">
            <div>
              <h3 style="margin: 0; font-size: 1.15rem;">Browser-Local Webhook HMAC-SHA256 Verifier</h3>
              <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
                Verifies <code>X-Ordex-Signature</code> and timestamp tolerance in the browser without network relay.
              </p>
            </div>
            <span class="badge badge-verification">Client-Side HMAC</span>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">
            {/* Left: Input Payload & Secret */}
            <div>
              <div style="margin-bottom: 1rem;">
                <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.35rem;">
                  Webhook Shared Secret
                </label>
                <input
                  type="text"
                  value={webhookSecret}
                  onInput={(e) => setWebhookSecret(e.target.value)}
                  style="width: 100%; font-family: var(--font-mono); font-size: 0.85rem; padding: 0.4rem 0.6rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm);"
                />
              </div>

              <div style="margin-bottom: 1rem;">
                <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.35rem;">
                  Raw Webhook Payload JSON
                </label>
                <textarea
                  rows={4}
                  value={webhookBody}
                  onInput={(e) => setWebhookBody(e.target.value)}
                  style="width: 100%; font-family: var(--font-mono); font-size: 0.85rem; padding: 0.6rem; border: 1px solid var(--color-border); border-radius: var(--radius-md);"
                />
              </div>

              <div style="margin-bottom: 1rem;">
                <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.35rem;">
                  Generated X-Ordex-Signature Header
                </label>
                <input
                  type="text"
                  value={signedHeader}
                  onInput={(e) => setSignedHeader(e.target.value)}
                  style="width: 100%; font-family: var(--font-mono); font-size: 0.8rem; padding: 0.4rem 0.6rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm);"
                />
              </div>

              <button class="btn btn-primary" onClick={handleVerifyWebhook}>
                Verify Signature Locally
              </button>
            </div>

            {/* Right: Verification Verdict */}
            <div>
              <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem;">Verification Verdict</h4>
              {!verificationResult ? (
                <div style="padding: 2rem; background: var(--color-bg-subtle); border-radius: var(--radius-md); text-align: center; color: var(--color-text-muted);">
                  Click "Verify Signature Locally" to test cryptographic header validation.
                </div>
              ) : (
                <div
                  class="panel"
                  style={{
                    backgroundColor: verificationResult.ok ? 'var(--color-success-bg)' : 'var(--color-danger-bg)',
                    borderColor: verificationResult.ok ? 'var(--color-success)' : 'var(--color-danger)'
                  }}
                >
                  <div style="font-weight: 800; font-size: 1.1rem; color: verificationResult.ok ? 'var(--color-success)' : 'var(--color-danger)'; margin-bottom: 0.5rem;">
                    {verificationResult.ok ? '✓ SIGNATURE_VALID' : '✖ SIGNATURE_REJECTED'}
                  </div>
                  <div style="font-size: 0.85rem;">
                    {verificationResult.ok
                      ? 'The delivery header matches the body digest and secret within timestamp tolerance window (300 seconds).'
                      : `Refusal Code: ${verificationResult.code}. Reason: ${verificationResult.reason}`}
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
