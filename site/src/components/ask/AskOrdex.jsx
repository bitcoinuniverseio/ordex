import { h } from 'preact';
import { useState } from 'preact/hooks';
import corpusData from '../../data/corpus.json';
import { TruthLabel } from '../shell/TruthLabel.jsx';

export function AskOrdex({ pageContext = '' }) {
  const [query, setQuery] = useState('');
  const [protocolVersion, setProtocolVersion] = useState('1.2');
  const [answerResult, setAnswerResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const sampleQuestions = [
    'How does SIGHASH_SINGLE protect seller public asks?',
    'What causes a SAT_FLOW_SHORTFALL refusal in purchase preflight?',
    'How do buyer-funded offers recover funds after expiry?',
    'How does SafeOps prevent accidental inscription burns during consolidation?',
    'What headers are required for HMAC webhook signature verification?'
  ];

  const handleAsk = async (userQuery) => {
    const q = (userQuery || query).trim();
    if (!q) return;

    setLoading(true);
    setAnswerResult(null);

    try {
      const res = await fetch('/api/docs/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          protocolVersion,
          pageContext
        })
      });

      if (res.ok) {
        const data = await res.json();
        setAnswerResult(data);
      } else {
        // Fallback to client-side retrieval if worker endpoint is unavailable (e.g. static preview)
        fallbackClientRetrieval(q);
      }
    } catch (err) {
      fallbackClientRetrieval(q);
    } finally {
      setLoading(false);
    }
  };

  const fallbackClientRetrieval = (q) => {
    const terms = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const scored = corpusData.map((chunk) => {
      let score = 0;
      const text = (chunk.title + ' ' + chunk.content).toLowerCase();
      for (const t of terms) {
        if (text.includes(t)) score += 10;
      }
      return { chunk, score };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);

    if (scored.length === 0) {
      setAnswerResult({
        ok: true,
        refused: false,
        answer: `No authoritative documentation found matching "${q}". Check the search bar or browse the API Reference.`,
        citations: []
      });
      return;
    }

    setAnswerResult({
      ok: true,
      refused: false,
      answer: scored.map((s) => s.chunk.content).join('\n\n'),
      citations: scored.map((s) => ({
        id: s.chunk.id,
        title: s.chunk.title,
        sourcePath: s.chunk.sourcePath,
        pointer: s.chunk.pointer,
        docUrl: s.chunk.docUrl || s.chunk.url
      }))
    });
  };

  const copyContextForAgent = () => {
    if (!answerResult) return;
    const promptContext = `Authoritative Ordex Context:\n\n${answerResult.answer}\n\nCitations:\n` +
      answerResult.citations.map((c) => `- ${c.title} (${c.sourcePath})`).join('\n');
    navigator.clipboard.writeText(promptContext);
    alert('Copied context for AI coding agent to clipboard!');
  };

  return (
    <div class="ask-ordex-container panel" style="padding: 1.5rem;">
      <div class="panel-header">
        <div>
          <h3 style="margin: 0; font-size: 1.25rem;">Ask Ordex: Source-Grounded Assistant</h3>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem; color: var(--color-text-secondary);">
            Strictly grounded in protocol specifications, OpenAPI contracts, and reference verifiers. Every claim carries an exact citation.
          </p>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <label style="font-size: 0.8rem; font-weight: 600;">Protocol Version:</label>
          <select
            class="btn btn-outline"
            value={protocolVersion}
            onChange={(e) => setProtocolVersion(e.target.value)}
            style="padding: 0.2rem 0.5rem; font-size: 0.85rem;"
          >
            <option value="1.2">Protocol 1.2 (Current)</option>
            <option value="1.1">Protocol 1.1</option>
            <option value="1.0">Protocol 1.0</option>
          </select>
        </div>
      </div>

      {/* Query Input Bar */}
      <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
        <input
          type="text"
          value={query}
          onInput={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAsk()}
          placeholder="Ask about protocol rules, invariants, sat flow, or API endpoints..."
          style="flex: 1; padding: 0.6rem 0.85rem; font-size: 0.95rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-canvas); color: var(--color-text-primary);"
        />
        <button
          class="btn btn-primary"
          onClick={() => handleAsk()}
          disabled={loading || !query.trim()}
          style="min-width: 110px;"
        >
          {loading ? 'Retrieving...' : 'Ask Ordex'}
        </button>
      </div>

      {/* Preset Questions */}
      <div style="display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 1.5rem;">
        <span style="font-size: 0.75rem; font-weight: 700; color: var(--color-text-muted); display: flex; align-items: center;">
          Try:
        </span>
        {sampleQuestions.map((sq, i) => (
          <button
            key={i}
            class="btn btn-secondary"
            style="font-size: 0.75rem; min-height: 28px; padding: 0.2rem 0.5rem;"
            onClick={() => {
              setQuery(sq);
              handleAsk(sq);
            }}
          >
            {sq}
          </button>
        ))}
      </div>

      {/* Answer Output Area */}
      {answerResult && (
        <div class="panel" style="background: var(--color-bg-subtle); padding: 1.25rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
            <div style="font-weight: 700; font-size: 1rem;">
              {answerResult.refused ? '⚠️ Request Refused' : 'Authoritative Sourced Answer'}
            </div>
            <div style="display: flex; gap: 0.5rem;">
              <button class="btn btn-outline" style="font-size: 0.75rem; min-height: 28px;" onClick={copyContextForAgent}>
                Copy Context for Coding Agent 🤖
              </button>
            </div>
          </div>

          <div style="font-size: 0.9rem; line-height: 1.5; color: var(--color-text-primary); white-space: pre-wrap; margin-bottom: 1.25rem;">
            {answerResult.answer}
          </div>

          {/* Citations List */}
          {answerResult.citations?.length > 0 && (
            <div style="padding-top: 1rem; border-top: 1px solid var(--color-border);">
              <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: var(--color-text-muted); margin-bottom: 0.5rem;">
                Verified Document Citations ({answerResult.citations.length})
              </div>
              <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                {answerResult.citations.map((c) => (
                  <a
                    key={c.id}
                    href={c.docUrl || c.url}
                    style="display: flex; align-items: center; justify-content: space-between; padding: 0.4rem 0.6rem; background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: 4px; font-size: 0.8rem; text-decoration: none;"
                  >
                    <div>
                      <strong style="color: var(--color-focus);">{c.title}</strong>
                      <span style="color: var(--color-text-muted); margin-left: 0.5rem;">
                        ({c.sourcePath})
                      </span>
                    </div>
                    <span style="font-family: var(--font-mono); font-size: 0.75em; color: var(--color-text-muted);">
                      {c.pointer}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
