import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import wizardsData from '../../data/wizards.json';
import operationsData from '../../data/operations.json';
import { resolveUrl } from '../../lib/base-url.js';
import { missingAnswers, wizardOutcome } from '../../lib/docs/wizard-outcome.mjs';
import { journeyStore } from '../../lib/session/journey-store';
import { recordToolEvidence, SOURCE_BUILD } from '../../lib/session/evidence';

// OX-S11: a wizard needs an answer on every step before it continues; answers are kept in this
// browser per wizard and cleared only by Reset. The outcome links come from the answers
// (lib/docs/wizard-outcome.mjs) and go to real routes, including a starter kit with the chosen
// runtime and capabilities. Finishing is learning progress (wizard:<id> evidence), not proof
// that anything ran; the checklist says which tool evidence is still needed.

const progressKey = (id) => `ordex.wizard.${id}`;
const loadProgress = (id) => {
  try {
    const v = JSON.parse(localStorage.getItem(progressKey(id)) || 'null');
    return v && typeof v === 'object' && v.answers && Number.isInteger(v.step) ? v : null;
  } catch {
    return null;
  }
};

export function WizardEngine({ initialWizardId = null }) {
  const [activeId, setActiveId] = useState(initialWizardId || wizardsData[0].id);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [finished, setFinished] = useState(false);
  const [announce, setAnnounce] = useState('');

  useEffect(() => {
    const wid = new URLSearchParams(window.location.search).get('wizard');
    if (wid && wizardsData.some((w) => w.id === wid)) setActiveId(wid);
  }, []);

  useEffect(() => {
    const saved = loadProgress(activeId);
    setAnswers(saved?.answers || {});
    setStep(Math.min(saved?.step || 0, (wizardsData.find((w) => w.id === activeId)?.steps.length || 1) - 1));
    setFinished(!!saved?.finished);
  }, [activeId]);

  const wizard = wizardsData.find((w) => w.id === activeId) || wizardsData[0];
  const current = wizard.steps[step];
  const isLast = step === wizard.steps.length - 1;
  const answered = current.isMulti ? (answers[current.id] || []).length > 0 : !!answers[current.id];
  const missing = missingAnswers(wizard, answers);
  const outcome = wizardOutcome(wizard, answers, operationsData);

  const save = (next) => {
    try {
      localStorage.setItem(progressKey(wizard.id), JSON.stringify({ answers, step, finished, ...next }));
    } catch {}
  };

  const choose = (value) => {
    const next = current.isMulti
      ? { ...answers, [current.id]: (answers[current.id] || []).includes(value) ? answers[current.id].filter((v) => v !== value) : [...(answers[current.id] || []), value] }
      : { ...answers, [current.id]: value };
    setAnswers(next);
    save({ answers: next });
  };

  const go = (to) => {
    setStep(to);
    save({ step: to });
    setAnnounce(`Step ${to + 1} of ${wizard.steps.length}: ${wizard.steps[to].title}`);
  };

  const reset = () => {
    setAnswers({});
    setStep(0);
    setFinished(false);
    try {
      localStorage.removeItem(progressKey(wizard.id));
    } catch {}
    setAnnounce('Answers cleared.');
  };

  const finish = () => {
    if (missing.length) return;
    setFinished(true);
    save({ finished: true });
    recordToolEvidence({ tool: 'wizards', operation: `wizard:${wizard.id}`, state: 'passed', evidenceClass: 'Deterministic example' });
    setAnnounce('Wizard finished. Your next steps are below.');
  };

  const label = (s, v) => s.options.find((o) => o.value === v)?.label || v;

  const downloadChecklist = async () => {
    const settings = await journeyStore.getSettings().catch(() => null);
    const origin = window.location.origin;
    const text = [
      `# ${wizard.title}`,
      '',
      wizard.summary,
      '',
      `Protocol scope: ${wizard.protocolScope}. Network: ${settings?.network || 'mainnet'}. Build: ${SOURCE_BUILD}.`,
      '',
      '## Your answers',
      ...wizard.steps.map((s) => `- ${s.title}: ${[].concat(answers[s.id] || []).map((v) => label(s, v)).join(', ') || 'not answered'}`),
      '',
      '## Next steps',
      wizard.outcome?.recommendation || '',
      ...outcome.links.map((l) => `- ${l.label}: ${origin}${resolveUrl(l.href)}`),
      '',
      '## Still to prove',
      'Finishing this wizard is learning progress. A mission stage completes only with evidence from the tools above, run against your own inputs.'
    ].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${wizard.id}-checklist.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setAnnounce(`Download started: ${wizard.id}-checklist.md`);
  };

  return (
    <div class="wizard-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      <div class="ox-sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      <div class="panel" style="padding: 1rem;">
        <h2 style="margin: 0 0 0.75rem; font-size: 1.05rem;">Guided workflows ({wizardsData.length})</h2>
        <div role="group" aria-label="Wizards" style="display: flex; flex-wrap: wrap; gap: 0.4rem;">
          {wizardsData.map((w) => (
            <button key={w.id} type="button" aria-pressed={w.id === activeId ? 'true' : 'false'} class={`btn ${w.id === activeId ? 'btn-primary' : 'btn-outline'}`} style="font-size: 0.8rem; min-height: 32px; padding: 0.3rem 0.65rem;" onClick={() => setActiveId(w.id)}>
              {w.title}
            </button>
          ))}
        </div>
      </div>

      <div class="panel">
        <div style="display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem;">
          <div>
            <span class="badge badge-verification">{wizard.category}</span> <span style="font-size: 0.8rem; color: var(--color-text-secondary);">Protocol {wizard.protocolScope}</span>
            <h2 style="margin: 0.25rem 0 0; font-size: 1.35rem;">{wizard.title}</h2>
            <p style="margin: 0.25rem 0 0; color: var(--color-text-secondary); font-size: 0.9rem;">{wizard.summary}</p>
          </div>
          <span style="font-size: 0.85rem; font-weight: 600; color: var(--color-text-secondary);">
            Step {step + 1} of {wizard.steps.length}
          </span>
        </div>

        <fieldset style="border: none; padding: 0; margin: 1.5rem 0;">
          <legend style="font-size: 1.1rem; font-weight: 700; margin-bottom: 0.25rem;">{current.title}</legend>
          <p style="margin: 0 0 1rem; font-size: 0.9rem; color: var(--color-text-secondary);">
            {current.description} {current.isMulti ? 'Choose one or more.' : 'Choose one.'}
          </p>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr)); gap: 0.75rem;">
            {current.options.map((opt) => {
              const selected = current.isMulti ? (answers[current.id] || []).includes(opt.value) : answers[current.id] === opt.value;
              return (
                <label key={opt.value} class="panel" style={{ padding: '1rem', cursor: 'pointer', display: 'flex', gap: '0.6rem', alignItems: 'flex-start', border: selected ? '2px solid var(--color-brand)' : '1px solid var(--color-border)', backgroundColor: selected ? 'var(--color-brand-subtle)' : 'var(--color-bg-surface)' }}>
                  <input type={current.isMulti ? 'checkbox' : 'radio'} name={`wizard-${wizard.id}-${current.id}`} value={opt.value} checked={selected} onChange={() => choose(opt.value)} style="margin-top: 0.2rem;" />
                  <span>
                    <span style="display: block; font-weight: 700; font-size: 0.95rem;">{opt.label}</span>
                    <span style="font-size: 0.8rem; color: var(--color-text-secondary); line-height: 1.35;">{opt.lead}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap; padding-top: 1rem; border-top: 1px solid var(--color-border);">
          <button type="button" class="btn btn-outline" onClick={() => go(step - 1)} disabled={step === 0}>
            Back
          </button>
          <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
            <button type="button" class="btn btn-outline" onClick={reset}>
              Reset
            </button>
            {!isLast ? (
              <button type="button" class="btn btn-primary" onClick={() => go(step + 1)} disabled={!answered}>
                Continue
              </button>
            ) : (
              <button type="button" class="btn btn-primary" onClick={finish} disabled={missing.length > 0}>
                Finish
              </button>
            )}
          </div>
        </div>
        {!answered && <p style="margin: 0.5rem 0 0; font-size: 0.8rem; color: var(--color-text-secondary);">Choose an answer to continue.</p>}

        {finished && (
          <section aria-labelledby="wizard-next" style="margin-top: 2rem; padding: 1.25rem; background: var(--color-bg-subtle); border-radius: var(--radius-md); border-left: 4px solid var(--color-brand);">
            <h3 id="wizard-next" style="margin: 0 0 0.5rem; font-size: 1rem;">
              Next steps
            </h3>
            <p style="margin: 0 0 1rem; font-size: 0.9rem;">{wizard.outcome?.recommendation}</p>
            <div style="display: flex; flex-wrap: wrap; gap: 0.6rem;">
              {outcome.links.map((l) => (
                <a key={l.href} href={resolveUrl(l.href)} class="btn btn-secondary">
                  {l.label}
                </a>
              ))}
              <button type="button" class="btn btn-primary" onClick={downloadChecklist}>
                Download checklist
              </button>
            </div>
            <p style="margin: 0.75rem 0 0; font-size: 0.8rem; color: var(--color-text-secondary);">Finishing a wizard is learning progress. Mission stages still need evidence from the tools.</p>
          </section>
        )}
      </div>
    </div>
  );
}
