import type { JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { PRODUCT_TOURS, type TourDefinition, type TourStep } from '../../lib/experience/tour-engine.js';
import {
  IconPlay,
  IconStepForward,
  IconStepBack,
  IconClose,
  IconArrowRight,
  IconExternalLink
} from './OrdexIcons.js';

interface TourProps {
  initialTourId?: string;
  basePath?: string;
}

export function TourGuide({
  initialTourId = 'tour-overview',
  basePath = '/ordex'
}: TourProps): JSX.Element {
  const [selectedTour, setSelectedTour] = useState<TourDefinition>(
    PRODUCT_TOURS.find((t) => t.id === initialTourId) || PRODUCT_TOURS[0]
  );
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'interactive' | 'captures'>('captures');
  const [captureTheme, setCaptureTheme] = useState<'desktopLight' | 'desktopDark' | 'mobileLight'>('desktopLight');

  const currentStep: TourStep | undefined = selectedTour.steps[activeStepIndex];

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        if (activeStepIndex < selectedTour.steps.length - 1) setActiveStepIndex(activeStepIndex + 1);
      } else if (e.key === 'ArrowLeft') {
        if (activeStepIndex > 0) setActiveStepIndex(activeStepIndex - 1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeStepIndex, selectedTour]);

  const handleSelectTour = (tourId: string) => {
    const found = PRODUCT_TOURS.find((t) => t.id === tourId);
    if (found) {
      setSelectedTour(found);
      setActiveStepIndex(0);
    }
  };

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header Banner */}
      <div
        style={{
          padding: '1.5rem',
          borderRadius: 'var(--ox-radius-lg)',
          backgroundColor: 'var(--ox-surface-panel)',
          border: '1px solid var(--ox-border-default)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-bitcoin-orange)' }}>
              Guided Product Tours
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>•</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--ox-text-muted)' }}>Deterministic Visual Walkthroughs</span>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={() => setViewMode(viewMode === 'captures' ? 'interactive' : 'captures')}
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                padding: '0.3rem 0.6rem',
                borderRadius: 'var(--ox-radius-sm)',
                backgroundColor: 'var(--ox-surface-subtle)',
                border: '1px solid var(--ox-border-default)',
                color: 'var(--ox-text-primary)',
                cursor: 'pointer'
              }}
            >
              Mode: {viewMode === 'captures' ? 'Visual Captures' : 'In-DOM Highlighting'}
            </button>
          </div>
        </div>

        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--ox-text-primary)' }}>
          {selectedTour.title}
        </h1>

        <p style={{ fontSize: '0.875rem', color: 'var(--ox-text-secondary)', margin: 0, lineHeight: 1.4 }}>
          {selectedTour.summary}
        </p>

        {/* Tour Selector Buttons */}
        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          {PRODUCT_TOURS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => handleSelectTour(t.id)}
              style={{
                padding: '0.35rem 0.625rem',
                borderRadius: 'var(--ox-radius-sm)',
                backgroundColor: selectedTour.id === t.id ? 'var(--ox-surface-inset)' : 'var(--ox-surface-subtle)',
                border: selectedTour.id === t.id ? '1px solid var(--ox-bitcoin-orange)' : '1px solid var(--ox-border-subtle)',
                color: selectedTour.id === t.id ? 'var(--ox-bitcoin-orange)' : 'var(--ox-text-secondary)',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {t.title}
            </button>
          ))}
        </div>
      </div>

      {/* Tour Presentation Container */}
      <div
        style={{
          borderRadius: 'var(--ox-radius-lg)',
          backgroundColor: 'var(--ox-surface-panel)',
          border: '1px solid var(--ox-border-default)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/* Step Progression Bar */}
        <div
          style={{
            padding: '0.75rem 1.25rem',
            borderBottom: '1px solid var(--ox-border-subtle)',
            backgroundColor: 'var(--ox-surface-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '0.5rem'
          }}
        >
          <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--ox-text-primary)' }}>
            Step {activeStepIndex + 1} of {selectedTour.steps.length}: {currentStep?.title}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {/* Viewport/Theme selector for captures */}
            {viewMode === 'captures' && (
              <div style={{ display: 'flex', gap: '0.25rem', marginRight: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setCaptureTheme('desktopLight')}
                  style={{
                    fontSize: '0.6875rem',
                    padding: '0.2rem 0.4rem',
                    borderRadius: 'var(--ox-radius-xs)',
                    backgroundColor: captureTheme === 'desktopLight' ? 'var(--ox-bitcoin-orange)' : 'transparent',
                    color: captureTheme === 'desktopLight' ? '#ffffff' : 'var(--ox-text-muted)',
                    border: '1px solid var(--ox-border-subtle)',
                    cursor: 'pointer'
                  }}
                >
                  Desktop Light
                </button>
                <button
                  type="button"
                  onClick={() => setCaptureTheme('desktopDark')}
                  style={{
                    fontSize: '0.6875rem',
                    padding: '0.2rem 0.4rem',
                    borderRadius: 'var(--ox-radius-xs)',
                    backgroundColor: captureTheme === 'desktopDark' ? 'var(--ox-bitcoin-orange)' : 'transparent',
                    color: captureTheme === 'desktopDark' ? '#ffffff' : 'var(--ox-text-muted)',
                    border: '1px solid var(--ox-border-subtle)',
                    cursor: 'pointer'
                  }}
                >
                  Desktop Dark
                </button>
                <button
                  type="button"
                  onClick={() => setCaptureTheme('mobileLight')}
                  style={{
                    fontSize: '0.6875rem',
                    padding: '0.2rem 0.4rem',
                    borderRadius: 'var(--ox-radius-xs)',
                    backgroundColor: captureTheme === 'mobileLight' ? 'var(--ox-bitcoin-orange)' : 'transparent',
                    color: captureTheme === 'mobileLight' ? '#ffffff' : 'var(--ox-text-muted)',
                    border: '1px solid var(--ox-border-subtle)',
                    cursor: 'pointer'
                  }}
                >
                  Mobile
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => setActiveStepIndex(Math.max(0, activeStepIndex - 1))}
              disabled={activeStepIndex <= 0}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0.25rem 0.5rem',
                borderRadius: 'var(--ox-radius-sm)',
                border: '1px solid var(--ox-border-default)',
                backgroundColor: 'var(--ox-surface-panel)',
                color: 'var(--ox-text-primary)',
                cursor: activeStepIndex <= 0 ? 'not-allowed' : 'pointer',
                opacity: activeStepIndex <= 0 ? 0.5 : 1
              }}
            >
              <IconStepBack size={12} />
            </button>

            <button
              type="button"
              onClick={() => setActiveStepIndex(Math.min(selectedTour.steps.length - 1, activeStepIndex + 1))}
              disabled={activeStepIndex >= selectedTour.steps.length - 1}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0.25rem 0.5rem',
                borderRadius: 'var(--ox-radius-sm)',
                border: '1px solid var(--ox-border-default)',
                backgroundColor: 'var(--ox-surface-panel)',
                color: 'var(--ox-text-primary)',
                cursor: activeStepIndex >= selectedTour.steps.length - 1 ? 'not-allowed' : 'pointer',
                opacity: activeStepIndex >= selectedTour.steps.length - 1 ? 0.5 : 1
              }}
            >
              <IconStepForward size={12} />
            </button>
          </div>
        </div>

        {/* Visual Capture Preview / Interactive Guide */}
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem' }}>
          {viewMode === 'captures' ? (
            <div style={{ maxWidth: captureTheme === 'mobileLight' ? '375px' : '900px', width: '100%', borderRadius: 'var(--ox-radius-md)', overflow: 'hidden', border: '1px solid var(--ox-border-default)', boxShadow: 'var(--ox-shadow-md)' }}>
              <img
                src={`${basePath}/${selectedTour.captures[captureTheme]}`}
                alt={`${selectedTour.title} deterministic browser capture`}
                style={{ width: '100%', height: 'auto', display: 'block' }}
              />
            </div>
          ) : (
            <div
              style={{
                maxWidth: '600px',
                width: '100%',
                padding: '1.5rem',
                borderRadius: 'var(--ox-radius-md)',
                backgroundColor: 'var(--ox-surface-subtle)',
                borderLeft: '4px solid var(--ox-bitcoin-orange)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ox-bitcoin-orange)' }}>
                  DOM Target: {currentStep?.targetSelector}
                </span>
                {currentStep?.badge && (
                  <span style={{ fontSize: '0.6875rem', padding: '0.1rem 0.35rem', borderRadius: 'var(--ox-radius-sm)', backgroundColor: 'var(--ox-surface-panel)' }}>
                    {currentStep.badge}
                  </span>
                )}
              </div>
              <h3 style={{ fontSize: '1.125rem', fontWeight: 700, margin: 0, color: 'var(--ox-text-primary)' }}>
                {currentStep?.title}
              </h3>
              <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--ox-text-secondary)', lineHeight: 1.4 }}>
                {currentStep?.content}
              </p>
            </div>
          )}

          {/* Related Mission Link */}
          {selectedTour.relatedMissionId && (
            <div style={{ fontSize: '0.8125rem' }}>
              <a
                href={`${basePath}/workspace/?mission=${selectedTour.relatedMissionId}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                  color: 'var(--ox-bitcoin-orange)',
                  fontWeight: 600,
                  textDecoration: 'none'
                }}
              >
                <span>Launch this mission in Mission Workspace</span>
                <IconArrowRight size={14} />
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
