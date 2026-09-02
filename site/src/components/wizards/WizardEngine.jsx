import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import wizardsData from '../../data/wizards.json';
import { TruthLabel } from '../shell/TruthLabel.jsx';
import { resolveUrl } from '../../lib/base-url.js';

export function WizardEngine({ initialWizardId = null }) {
  const [activeWizardId, setActiveWizardId] = useState(initialWizardId || wizardsData[0]?.id);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [filterRole, setFilterRole] = useState('all');

  // Read URL params if present (sanitized choices only)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const wid = params.get('wizard');
      if (wid && wizardsData.some((w) => w.id === wid)) {
        setActiveWizardId(wid);
      }
    } catch (e) {}
  }, []);

  const wizard = wizardsData.find((w) => w.id === activeWizardId) || wizardsData[0];
  const steps = wizard.steps || [];
  const currentStep = steps[currentStepIndex] || steps[0];
  const isLastStep = currentStepIndex === steps.length - 1;

  const selectOption = (stepId, value, isMulti) => {
    setAnswers((prev) => {
      if (isMulti) {
        const currentList = prev[stepId] || [];
        const nextList = currentList.includes(value)
          ? currentList.filter((v) => v !== value)
          : [...currentList, value];
        return { ...prev, [stepId]: nextList };
      }
      return { ...prev, [stepId]: value };
    });
  };

  const handleNext = () => {
    if (!isLastStep) {
      setCurrentStepIndex((prev) => prev + 1);
    }
  };

  const handlePrev = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  };

  const handleReset = () => {
    setAnswers({});
    setCurrentStepIndex(0);
  };

  const downloadChecklist = () => {
    const text = `# Ordex Integration Checklist: ${wizard.title}\n\n` +
      `Summary: ${wizard.summary}\n` +
      `Protocol Scope: ${wizard.protocolScope}\n\n` +
      `## Selected Parameters\n` +
      Object.entries(answers).map(([k, v]) => `- **${k}**: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n') +
      `\n\n## Next Actions\n` +
      `- ${wizard.outcome?.recommendation || 'Proceed with integration'}\n` +
      `- Review reference documentation: https://bitcoinuniverseio.github.io/ordex/\n`;

    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${wizard.id}-checklist.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div class="wizard-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      {/* Wizard Chooser Tabs */}
      <div class="panel" style="padding: 1rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
          <h3 style="margin: 0; font-size: 1.05rem;">Interactive Guided Workflows (12 Wizards)</h3>
          <span style="font-size: 0.8rem; color: var(--color-text-muted);">
            Step-by-step guidance & decision trees
          </span>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 0.4rem;">
          {wizardsData.map((w) => {
            const isCurrent = w.id === activeWizardId;
            return (
              <button
                key={w.id}
                class={`btn ${isCurrent ? 'btn-primary' : 'btn-outline'}`}
                style="font-size: 0.8rem; min-height: 32px; padding: 0.3rem 0.65rem;"
                onClick={() => {
                  setActiveWizardId(w.id);
                  setCurrentStepIndex(0);
                  setAnswers({});
                }}
              >
                {w.title}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active Wizard Flow */}
      <div class="panel">
        <div class="panel-header">
          <div>
            <div style="display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.25rem;">
              <span class="badge badge-verification">{wizard.category}</span>
              <span style="font-size: 0.8rem; color: var(--color-text-muted);">Protocol {wizard.protocolScope}</span>
            </div>
            <h2 style="margin: 0; font-size: 1.35rem;">{wizard.title}</h2>
            <p style="margin: 0.25rem 0 0 0; color: var(--color-text-secondary); font-size: 0.9rem;">
              {wizard.summary}
            </p>
          </div>
          <div>
            <span style="font-size: 0.85rem; font-weight: 600; color: var(--color-text-muted);">
              Step {currentStepIndex + 1} of {steps.length}
            </span>
          </div>
        </div>

        {/* Step Progress Bar */}
        <div style="display: flex; gap: 0.3rem; margin-bottom: 1.5rem;">
          {steps.map((s, idx) => (
            <div
              key={s.id}
              style={{
                flex: 1,
                height: '4px',
                borderRadius: '2px',
                backgroundColor: idx <= currentStepIndex ? 'var(--color-brand)' : 'var(--color-bg-muted)'
              }}
            />
          ))}
        </div>

        {/* Step Body */}
        <div style="margin-bottom: 2rem;">
          <h3 style="margin: 0 0 0.5rem 0; font-size: 1.1rem;">
            {currentStep.title}
          </h3>
          <p style="margin: 0 0 1.25rem 0; font-size: 0.9rem; color: var(--color-text-secondary);">
            {currentStep.description}
          </p>

          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 0.75rem;">
            {currentStep.options?.map((opt) => {
              const isSelected = currentStep.isMulti
                ? (answers[currentStep.id] || []).includes(opt.value)
                : answers[currentStep.id] === opt.value;

              return (
                <div
                  key={opt.value}
                  class={`panel ${isSelected ? 'selected' : ''}`}
                  style={{
                    padding: '1rem',
                    cursor: 'pointer',
                    border: isSelected ? '2px solid var(--color-brand)' : '1px solid var(--color-border)',
                    backgroundColor: isSelected ? 'var(--color-brand-subtle)' : 'var(--color-bg-surface)'
                  }}
                  onClick={() => selectOption(currentStep.id, opt.value, currentStep.isMulti)}
                  role="button"
                  tabIndex={0}
                >
                  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.3rem;">
                    <span style="font-weight: 700; font-size: 0.95rem;">{opt.label}</span>
                    <span style="font-size: 1rem;">{isSelected ? '☑️' : '◻️'}</span>
                  </div>
                  <div style="font-size: 0.8rem; color: var(--color-text-secondary); line-height: 1.35;">
                    {opt.lead}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Navigation & Controls */}
        <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 1rem; border-top: 1px solid var(--color-border);">
          <button
            class="btn btn-outline"
            onClick={handlePrev}
            disabled={currentStepIndex === 0}
          >
            ← Previous
          </button>

          <div style="display: flex; gap: 0.5rem;">
            <button class="btn btn-outline" onClick={handleReset}>
              Reset
            </button>
            {!isLastStep ? (
              <button class="btn btn-primary" onClick={handleNext}>
                Continue →
              </button>
            ) : (
              <button class="btn btn-primary" onClick={downloadChecklist}>
                📥 Download Checklist
              </button>
            )}
          </div>
        </div>

        {/* Outcome Summary on Last Step */}
        {isLastStep && (
          <div style="margin-top: 2rem; padding: 1.25rem; background: var(--color-bg-subtle); border-radius: var(--radius-md); border-left: 4px solid var(--color-brand);">
            <h4 style="margin: 0 0 0.5rem 0; font-size: 1rem;">Recommended Next Steps</h4>
            <p style="margin: 0 0 1rem 0; font-size: 0.9rem; color: var(--color-text-primary);">
              {wizard.outcome?.recommendation}
            </p>
            <div style="display: flex; flex-wrap: wrap; gap: 0.6rem;">
              {wizard.outcome?.apiOperation && (
                <a href={`/reference/api/#${wizard.outcome.apiOperation}`} class="btn btn-secondary">
                  Open in API Playground 🚀
                </a>
              )}
              {wizard.outcome?.verifierFamily && (
                <a href={resolveUrl(`/lab?family=${wizard.outcome.verifierFamily}`)} class="btn btn-secondary">
                  Open in Protocol Lab 🔬
                </a>
              )}
              <a href={resolveUrl('/kits')} class="btn btn-primary">
                Generate Integration Kit 📦
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
