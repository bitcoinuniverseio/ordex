import { h } from 'preact';
import { useRef, useState } from 'preact/hooks';
import corpusData from '../../data/corpus.json';
import { resolveUrl } from '../../lib/base-url.js';
import { detectSecrets } from '../../lib/security/sanitizer';
import { rankCorpus, validateAskResponse } from '../../lib/docs/docs-contract.mjs';
import { callDocsApi, DOCS_API_BASE } from '../../lib/docs/docs-client.mjs';

// OX-S11: Ask asks the docs service (PUBLIC_ORDEX_DOCS_API_BASE, see docs-client.mjs) and
// validates its answer. When the service is not reachable it answers from the documentation
// bundled in this page with the same extractive retrieval (rankCorpus), and says so. Answers
// are quoted sections with their citations, never generated text. Key material is refused
// before anything is sent; a newer question cancels the one in flight.

const VERSIONS = [...new Set(corpusData.map((c) => c.protocolVersion))].sort().reverse();
const SAMPLES = [
  'How does SIGHASH_SINGLE protect seller public asks?',
  'What causes a SAT_FLOW_SHORTFALL refusal?',
  'How do buyer-funded offers recover funds after expiry?',
  'How does SafeOps keep inscriptions out of a consolidation?',
  'How is a webhook signature verified?'
];

function localAnswer(query, protocolVersion, pageContext) {
  const chunks = rankCorpus(corpusData, { query, protocolVersion, pageContext });
  return {
    ok: true,
    refused: false,
    noSources: chunks.length === 0,
    mode: 'local',
    protocolVersion,
    extracts: chunks.map((c) => ({ citationId: c.id, text: c.content.replace(/\r/g, '').slice(0, 700) })),
    citations: chunks.map((c) => ({ id: c.id, title: c.title.replace(/\r/g, ''), sourcePath: c.sourcePath, pointer: c.pointer, protocolVersion: c.protocolVersion, docUrl: c.docUrl }))
  };
}

export function AskOrdex({ pageContext = '' }) {
  const [query, setQuery] = useState('');
  const [protocolVersion, setProtocolVersion] = useState(VERSIONS[0]);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState({ state: 'idle', message: '' });
  const [announce, setAnnounce] = useState('');
  const inflight = useRef(null);

  const ask = async (text) => {
    const q = (text ?? query).trim();
    if (!q) return;
    if (q.length > 500) {
      setStatus({ state: 'error', message: 'Questions are limited to 500 characters.' });
      return;
    }
    if (detectSecrets(q).hasHighConfidenceSecrets) {
      setResult(null);
      setStatus({ state: 'refused', message: 'The question contains what looks like private key material. It was not sent anywhere. Never paste keys or seed phrases into any tool.' });
      return;
    }
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setStatus({ state: 'loading', message: '' });
    setResult(null);
    const res = await callDocsApi('/api/docs/ask', { method: 'POST', body: { query: q, protocolVersion, pageContext }, signal: ctrl.signal });
    if (res.kind === 'cancelled' || inflight.current !== ctrl) return;
    if (res.kind === 'ok') {
      const problem = validateAskResponse(res.data);
      if (!problem) {
        setResult({ ...res.data, mode: 'service' });
        setStatus({ state: 'done', message: '' });
        setAnnounce(res.data.refused ? 'The question was refused.' : res.data.noSources ? 'No documentation matched.' : `Answered with ${res.data.citations.length} citations.`);
        return;
      }
      setStatus({ state: 'fallback', message: `${problem} Answered from the documentation in this page instead.` });
    } else {
      setStatus({ state: 'fallback', message: `${res.message} Answered from the documentation in this page instead${DOCS_API_BASE ? '' : ' (no docs service is configured for this build)'}.` });
    }
    const local = localAnswer(q, protocolVersion, pageContext);
    setResult(local);
    setAnnounce(local.noSources ? 'No documentation matched.' : `Answered from this page with ${local.citations.length} citations.`);
  };

  const copyContext = async () => {
    if (!result) return;
    const text = [
      `Ordex documentation, protocol ${result.protocolVersion}:`,
      ...(result.extracts || []).map((e) => {
        const c = result.citations.find((x) => x.id === e.citationId);
        return `\n## ${c?.title}\nSource: ${c?.sourcePath}\n${e.text}`;
      })
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setAnnounce('The cited extracts were copied.');
    } catch {
      setAnnounce('Copying failed. Select the extracts and copy them yourself.');
    }
  };

  const linkFor = (docUrl) => (docUrl.startsWith(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/`) ? docUrl : resolveUrl(docUrl));

  return (
    <div class="ask-ordex-container panel" style="padding: 1.5rem;">
      <div class="ox-sr-only" role="status" aria-live="polite">{announce}</div>
      <div class="panel-header" style="flex-wrap: wrap; gap: 0.75rem;">
        <div>
          <h2 style="margin: 0; font-size: 1.25rem;">Ask Ordex</h2>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
            Answers are quoted sections of the specifications, the API contract and the refusal codes, each with a link to its page. Nothing is generated.
          </p>
        </div>
        <label style="font-size: 0.8rem; font-weight: 600; display: flex; align-items: center; gap: 0.5rem;">
          Protocol version
          <select class="btn btn-outline" value={protocolVersion} onChange={(e) => setProtocolVersion(e.currentTarget.value)} style="padding: 0.2rem 0.5rem; font-size: 0.85rem;">
            {VERSIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      {VERSIONS.length === 1 && <p style="margin: 0 0 0.75rem; font-size: 0.8rem; color: var(--color-text-secondary);">Only protocol {VERSIONS[0]} is indexed.</p>}

      <form
        style="display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap;"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <label for="ask-input" class="ox-sr-only">
          Your question
        </label>
        <input
          id="ask-input"
          type="text"
          value={query}
          maxLength={500}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder="Ask about protocol rules, sat flow, refusals or API operations"
          style="flex: 1 1 16rem; min-width: 0; padding: 0.6rem 0.85rem; font-size: 0.95rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-canvas); color: var(--color-text-primary);"
        />
        <button class="btn btn-primary" type="submit" disabled={status.state === 'loading' || !query.trim()}>
          {status.state === 'loading' ? 'Searching...' : 'Ask'}
        </button>
      </form>

      <div style="display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 1.5rem; align-items: center;">
        <span style="font-size: 0.75rem; font-weight: 700; color: var(--color-text-secondary);">Try:</span>
        {SAMPLES.map((sq) => (
          <button
            key={sq}
            type="button"
            class="btn btn-secondary"
            style="font-size: 0.75rem; min-height: 28px; padding: 0.2rem 0.5rem;"
            onClick={() => {
              setQuery(sq);
              ask(sq);
            }}
          >
            {sq}
          </button>
        ))}
      </div>

      {(status.state === 'refused' || status.state === 'error') && (
        <p role="alert" style="margin: 0 0 1rem; color: var(--color-danger); font-size: 0.9rem;">
          {status.message}
        </p>
      )}
      {status.state === 'fallback' && <p style="margin: 0 0 0.75rem; font-size: 0.85rem; color: var(--color-text-secondary);">{status.message}</p>}

      {result && (
        <div class="panel" style="background: var(--color-bg-subtle); padding: 1.25rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; gap: 0.5rem; flex-wrap: wrap;">
            <div style="font-weight: 700; font-size: 1rem;">
              {result.refused ? 'Refused' : result.noSources ? 'No matching documentation' : 'Quoted from the documentation'}
              <span style="font-weight: 400; font-size: 0.8rem; color: var(--color-text-secondary);">
                {' '}
                · {result.mode === 'service' ? 'docs service' : 'this page'} · protocol {result.protocolVersion}
              </span>
            </div>
            {!result.refused && !result.noSources && (
              <button type="button" class="btn btn-outline" style="font-size: 0.75rem; min-height: 28px;" onClick={copyContext}>
                Copy extracts for a coding agent
              </button>
            )}
          </div>
          {result.refused && <p style="margin: 0 0 1rem; font-size: 0.9rem;">{result.answer}</p>}
          {result.noSources && <p style="margin: 0; font-size: 0.9rem;">Nothing in the protocol {result.protocolVersion} documentation matches. Try other words, or browse the API reference.</p>}
          {(result.extracts || []).map((e) => {
            const c = result.citations.find((x) => x.id === e.citationId);
            if (!c) return null;
            return (
              <article key={e.citationId} style="margin-bottom: 1rem;">
                <h3 style="margin: 0 0 0.25rem; font-size: 0.9rem;">
                  <a href={linkFor(c.docUrl)}>{c.title}</a>
                </h3>
                <p style="margin: 0; font-size: 0.875rem; line-height: 1.5; white-space: pre-wrap;">{e.text}</p>
                <p style="margin: 0.25rem 0 0; font-size: 0.75rem; color: var(--color-text-secondary); font-family: var(--font-mono);">
                  {c.sourcePath} {c.pointer}
                </p>
              </article>
            );
          })}
          {result.refused && result.citations.length > 0 && (
            <ul style="margin: 0; padding-left: 1.2rem; font-size: 0.85rem;">
              {result.citations.map((c) => (
                <li key={c.id}>
                  <a href={linkFor(c.docUrl)}>{c.title}</a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
