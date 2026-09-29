import { h } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { callDocsApi } from '../../lib/docs/docs-client.mjs';
import { FEEDBACK_CATEGORIES, normalizeRoute } from '../../lib/docs/docs-contract.mjs';
import { detectSecrets } from '../../lib/security/sanitizer';

// OX-S11: feedback goes to the docs service (OX-P08) and counts as sent only when the service
// returns its stored receipt. A retry reuses the same submission id, so it can never create a
// second record; the draft is kept on failure. Key material is refused before sending.

const LABELS = {
  helpful: 'Helpful',
  not_helpful: 'Not helpful',
  unclear: 'Unclear',
  outdated: 'Outdated',
  missing_example: 'Missing example',
  broken_workflow: 'Broken workflow',
  other: 'Other'
};
const BUILD = import.meta.env.PUBLIC_ORDEX_BUILD_REVISION || 'unknown';
// crypto.randomUUID is available in every secure context the site is served from.
const newId = () => crypto.randomUUID();

export function FeedbackWidget({ route = '/', heading = '' }) {
  const [isOpen, setIsOpen] = useState(false);
  const [category, setCategory] = useState(null);
  const [comment, setComment] = useState('');
  const [state, setState] = useState({ status: 'idle', message: '' });
  const submissionId = useRef(null);

  const choose = (id) => {
    if (id !== category) submissionId.current = null;
    setCategory(id);
    setIsOpen(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!category) {
      setState({ status: 'error', message: 'Choose a category first.' });
      return;
    }
    if (detectSecrets(`${comment} ${heading}`).hasHighConfidenceSecrets) {
      setState({ status: 'error', message: 'The comment contains what looks like private key material, so it was not sent. Remove it and try again.' });
      return;
    }
    submissionId.current ||= newId();
    setState({ status: 'submitting', message: '' });
    const res = await callDocsApi('/api/docs/feedback', {
      method: 'POST',
      body: {
        submissionId: submissionId.current,
        category,
        route: normalizeRoute(window.location.pathname) || normalizeRoute(route) || '/',
        heading: String(heading).slice(0, 200),
        comment: comment.slice(0, 1000),
        protocolVersion: '1.2',
        buildRevision: /^[0-9a-f]{7,64}$/.test(BUILD) ? BUILD : 'unknown'
      }
    });
    if (res.kind === 'ok' && res.data?.receipt?.id === submissionId.current) {
      setState({ status: 'sent', message: `Received and stored at ${res.data.receipt.storedAt}. Reference ${res.data.receipt.id.slice(0, 8)}.` });
      submissionId.current = null;
      setComment('');
      return;
    }
    const why = res.kind === 'http' ? (res.data?.errors ? res.data.errors.join('; ') : res.message) : res.message || 'The response had no receipt.';
    setState({ status: 'error', message: `Not sent: ${why} Your text is kept; try again.` });
  };

  return (
    <section class="feedback-section panel" style="margin-top: 3rem; border-top: 2px solid var(--color-border); padding: 1.5rem;" aria-labelledby="feedback-heading">
      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem;">
        <div>
          <h2 id="feedback-heading" style="margin: 0 0 0.25rem 0; font-size: 1rem;">
            Was this page helpful?
          </h2>
          <p style="margin: 0; font-size: 0.85rem; color: var(--color-text-secondary);">
            Sent to the Ordex docs service with this page, the build and your category and comment. No cookies, addresses or account data.
          </p>
        </div>
        {state.status !== 'sent' && (
          <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
            <button type="button" class={`btn ${category === 'helpful' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => choose('helpful')}>
              Helpful
            </button>
            <button type="button" class={`btn ${category === 'not_helpful' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => choose('not_helpful')}>
              Not helpful
            </button>
            <button type="button" class="btn btn-outline" aria-expanded={isOpen ? 'true' : 'false'} onClick={() => setIsOpen(!isOpen)}>
              More feedback
            </button>
          </div>
        )}
      </div>

      <div role="status" aria-live="polite" style="margin-top: 0.75rem; font-size: 0.9rem;">
        {state.status === 'sent' && <strong style="color: var(--color-success);">Thank you. {state.message}</strong>}
      </div>
      {state.status === 'error' && (
        <p role="alert" style="margin: 0.5rem 0 0; color: var(--color-danger); font-size: 0.9rem;">
          {state.message}
        </p>
      )}

      {isOpen && state.status !== 'sent' && (
        <form onSubmit={submit} style="margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--color-border);">
          <fieldset style="border: none; padding: 0; margin: 0 0 1rem;">
            <legend style="font-size: 0.85rem; font-weight: 600; margin-bottom: 0.5rem;">Category</legend>
            <div style="display: flex; flex-wrap: wrap; gap: 0.4rem;">
              {FEEDBACK_CATEGORIES.map((id) => (
                <button type="button" key={id} aria-pressed={category === id ? 'true' : 'false'} class={`btn ${category === id ? 'btn-primary' : 'btn-secondary'}`} style="font-size: 0.8rem; min-height: 32px; padding: 0.25rem 0.6rem;" onClick={() => choose(id)}>
                  {LABELS[id]}
                </button>
              ))}
            </div>
          </fieldset>
          <label for="feedback-comment" style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.25rem;">
            Details (optional, up to 1000 characters)
          </label>
          <p id="feedback-comment-hint" style="font-size: 0.8rem; color: var(--color-text-secondary); margin: 0 0 0.4rem;">
            Do not include keys, seed phrases, addresses or PSBTs. Addresses, hashes and emails are removed before storage.
          </p>
          <textarea
            id="feedback-comment"
            aria-describedby="feedback-comment-hint"
            rows={3}
            value={comment}
            maxLength={1000}
            onInput={(e) => setComment(e.currentTarget.value.slice(0, 1000))}
            style="width: 100%; box-sizing: border-box; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.6rem; font-family: var(--font-sans); font-size: 0.85rem; background: var(--color-bg-canvas); color: var(--color-text-primary);"
          />
          <div style="text-align: right; font-size: 0.75rem; color: var(--color-text-secondary);">{comment.length}/1000</div>
          <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem;">
            <button type="button" class="btn btn-outline" onClick={() => setIsOpen(false)}>
              Close
            </button>
            <button type="submit" class="btn btn-primary" disabled={state.status === 'submitting'}>
              {state.status === 'submitting' ? 'Sending...' : state.status === 'error' ? 'Try again' : 'Send feedback'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
