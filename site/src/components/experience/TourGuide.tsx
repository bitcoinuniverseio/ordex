import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { CAPTURE_REVISION, PRODUCT_TOURS, capturesFor, stepHref, type TourCapture } from '../../lib/experience/tour-engine.js';
import { journeyStore } from '../../lib/session/journey-store.js';
import type { TourProgress } from '../../lib/session/journey-schema.js';

// OX-S10: the tour index. Starting a tour opens its first step on the real page, where
// TourOverlay highlights the element. A paused tour (kept in the journey settings) can be
// resumed. Screenshots are shown only when scripts/capture-walkthroughs.mjs captured them from
// the built site; otherwise the page says there are none.

interface TourProps {
  basePath?: string;
}

const VARIANT_LABEL: Record<TourCapture['variant'], string> = {
  'desktop-light': 'Desktop, light theme',
  'desktop-dark': 'Desktop, dark theme',
  'mobile-light': 'Mobile, light theme'
};

export function TourGuide({ basePath = '/ordex' }: TourProps): JSX.Element {
  const [paused, setPaused] = useState<TourProgress | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      journeyStore
        .getSettings()
        .then((s) => live && setPaused(s.tour && s.tour.paused ? s.tour : null))
        .catch(() => {});
    load();
    const off = journeyStore.subscribe((e) => e.type === 'settings' && load());
    return () => {
      live = false;
      off();
    };
  }, []);

  const pausedTour = paused ? PRODUCT_TOURS.find((t) => t.id === paused.id) : undefined;
  const card = { padding: '1.25rem', borderRadius: 'var(--ox-radius-lg)', backgroundColor: 'var(--ox-surface-panel)', border: '1px solid var(--ox-border-default)', display: 'flex', flexDirection: 'column', gap: '0.75rem' } as const;
  const startLink = { display: 'inline-flex', alignItems: 'center', minHeight: '40px', padding: '0.45rem 1rem', borderRadius: 'var(--ox-radius-md)', background: 'var(--ox-action-bg)', color: 'var(--ox-action-fg)', fontWeight: 700, fontSize: '0.875rem', textDecoration: 'none', alignSelf: 'flex-start' } as const;

  return (
    <div style={{ maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={card}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>Guided tours</h1>
        <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--ox-text-secondary)', lineHeight: 1.5 }}>
          Each tour opens the real pages and points at the parts it describes. Use Next and Back or the arrow keys inside the tour card, Pause to continue later, and Escape to end.
        </p>
        {pausedTour && paused && paused.step < pausedTour.steps.length && (
          <p role="status" style={{ margin: 0, fontSize: '0.875rem' }}>
            Paused: {pausedTour.title}, step {paused.step + 1} of {pausedTour.steps.length}.{' '}
            <a href={stepHref(basePath, pausedTour, paused.step)} style={{ textDecoration: 'underline' }}>Resume the tour</a>
          </p>
        )}
      </div>

      {PRODUCT_TOURS.map((tour) => {
        const shots = tour.steps.flatMap((s) => capturesFor(tour.id, s.id).map((c) => ({ step: s, capture: c })));
        return (
          <section key={tour.id} style={card} aria-labelledby={`${tour.id}-title`}>
            <h2 id={`${tour.id}-title`} style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0 }}>
              {tour.title}
            </h2>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--ox-text-secondary)', lineHeight: 1.5 }}>{tour.summary}</p>
            <ol style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.875rem', lineHeight: 1.6 }}>
              {tour.steps.map((s, i) => (
                <li key={s.id}>
                  <a href={stepHref(basePath, tour, i)} style={{ textDecoration: 'underline' }}>{s.title}</a> <span style={{ color: 'var(--ox-text-secondary)' }}>on {s.route.split('?')[0]}</span>
                </li>
              ))}
            </ol>
            <a href={stepHref(basePath, tour, 0)} style={startLink} aria-label={`Start the tour: ${tour.title}`}>
              Start tour
            </a>
            {shots.length > 0 ? (
              <details>
                <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem' }}>Screenshots ({shots.length}), captured from build {CAPTURE_REVISION}</summary>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))', gap: '1rem', marginTop: '0.75rem' }}>
                  {shots.map(({ step, capture }) => (
                    <figure key={capture.file} style={{ margin: 0 }}>
                      <img src={`${basePath}/${capture.file}`} width={capture.width} height={capture.height} loading="lazy" alt={`${step.title}: ${step.content} (${VARIANT_LABEL[capture.variant]})`} style={{ width: '100%', height: 'auto', border: '1px solid var(--ox-border-default)', borderRadius: 'var(--ox-radius-md)' }} />
                      <figcaption style={{ fontSize: '0.75rem', color: 'var(--ox-text-secondary)' }}>
                        {step.title}, {VARIANT_LABEL[capture.variant]}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </details>
            ) : (
              <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--ox-text-secondary)' }}>No screenshots have been captured for this build. Start the tour to see the live pages.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
