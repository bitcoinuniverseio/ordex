import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { onStepPage, stepHref, tourFromSearch, type TourDefinition } from '../../lib/experience/tour-engine.js';
import { journeyStore } from '../../lib/session/journey-store.js';

// OX-S10: the live tour. When the URL carries ?tour=&step=, this finds the step's real
// [data-tour] element on the current page, outlines it and shows the step beside it. It follows
// scrolling and resizing, waits for targets that appear after an interaction, and never
// invents one: a missing target is said to be missing. Escape ends the tour, arrow keys work
// only inside the tour card, focus returns where it was, and motion follows the user setting.

interface OverlayProps {
  basePath?: string;
}

type Rect = { top: number; left: number; width: number; height: number };

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function TourOverlay({ basePath = '/ordex' }: OverlayProps): JSX.Element | null {
  const [active, setActive] = useState<{ tour: TourDefinition; index: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const found = tourFromSearch(window.location.search);
    if (found) {
      returnFocus.current = document.activeElement as HTMLElement;
      setActive(found);
    }
    const mq = window.matchMedia('(max-width: 640px)');
    const onMq = () => setNarrow(mq.matches);
    onMq();
    mq.addEventListener('change', onMq);
    return () => mq.removeEventListener('change', onMq);
  }, []);

  const step = active ? active.tour.steps[active.index] : null;
  const onPage = step ? onStepPage(step, basePath, window.location) : false;

  // Find the target, follow it, and wait for it when it is rendered later.
  useEffect(() => {
    if (!step || !onPage) return;
    let target: HTMLElement | null = null;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!target || !target.isConnected) return;
        const r = target.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      });
    };
    const attach = () => {
      target = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (!target) return false;
      setMissing(false);
      target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      measure();
      return true;
    };
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    let observer: MutationObserver | null = null;
    let timer = 0;
    if (attach()) resize?.observe(target!);
    else {
      setRect(null);
      observer = new MutationObserver(() => {
        if (attach()) {
          resize?.observe(target!);
          observer?.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tour'] });
      timer = window.setTimeout(() => !target && setMissing(true), 4000);
    }
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer?.disconnect();
      resize?.disconnect();
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [active, onPage]);

  // Move focus to the step so screen readers announce it; keep Escape global to end the tour.
  useEffect(() => {
    if (!step) return;
    headingRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = document.activeElement as HTMLElement | null;
      const editing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) && !cardRef.current?.contains(el);
      if (editing) return;
      e.preventDefault();
      end();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  if (!active || !step) return null;
  const { tour, index } = active;
  const total = tour.steps.length;

  const updateUrl = (next: number | null) => {
    const url = new URL(window.location.href);
    if (next === null) {
      url.searchParams.delete('tour');
      url.searchParams.delete('step');
    } else {
      url.searchParams.set('tour', tour.id);
      url.searchParams.set('step', String(next + 1));
    }
    window.history.replaceState(null, '', url);
  };

  const go = (next: number) => {
    const nextStep = tour.steps[next];
    if (!onStepPage(nextStep, basePath, window.location)) {
      window.location.href = stepHref(basePath, tour, next);
      return;
    }
    updateUrl(next);
    setActive({ tour, index: next });
  };

  const saveProgress = (value: { id: string; step: number; paused: boolean } | null) =>
    journeyStore
      .getSettings()
      .then((s) => journeyStore.saveSettings({ ...s, tour: value }))
      .catch(() => {});

  function end() {
    updateUrl(null);
    setActive(null);
    saveProgress(null);
    const target = returnFocus.current && document.contains(returnFocus.current) ? returnFocus.current : document.getElementById('main-content');
    target?.focus?.();
  }

  const pause = () => {
    setActive(null);
    returnFocus.current?.focus?.();
    // The tour leaves the URL once the paused step is stored, so a page that
    // opens next (Resume the tour) always finds it.
    void saveProgress({ id: tour.id, step: index, paused: true }).then(() => updateUrl(null));
  };

  const onCardKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' && index < total - 1) {
      e.preventDefault();
      go(index + 1);
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      go(index - 1);
    }
  };

  const pad = 6;
  const cardWidth = 340;
  let cardStyle: JSX.CSSProperties;
  if (narrow || !rect) {
    cardStyle = { position: 'fixed', left: '0.75rem', right: '0.75rem', bottom: '0.75rem' };
  } else {
    const below = rect.top + rect.height + pad + 12;
    const fitsBelow = below + 220 < window.innerHeight;
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - cardWidth - 12);
    cardStyle = fitsBelow ? { position: 'fixed', top: `${below}px`, left: `${left}px`, width: `${cardWidth}px` } : { position: 'fixed', bottom: `${Math.max(12, window.innerHeight - rect.top + pad + 12)}px`, left: `${left}px`, width: `${cardWidth}px` };
  }
  const btn = { minHeight: '36px', minWidth: '44px', padding: '0.35rem 0.75rem', borderRadius: 'var(--ox-radius-md)', border: '1px solid var(--ox-border-strong)', background: 'var(--ox-surface-subtle)', color: 'var(--ox-text-primary)', fontWeight: 600, fontSize: '0.8125rem', cursor: 'pointer' } as const;

  return (
    <div class="ox-tour-overlay">
      {onPage && rect && (
        <div
          aria-hidden="true"
          data-tour-highlight={step.target}
          style={{ position: 'fixed', top: `${rect.top - pad}px`, left: `${rect.left - pad}px`, width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px`, border: '3px solid var(--ox-bitcoin-orange)', borderRadius: 'var(--ox-radius-md)', boxShadow: '0 0 0 4px rgba(247, 147, 26, 0.25)', pointerEvents: 'none', zIndex: 9990, transition: reducedMotion() ? 'none' : 'all 0.15s ease' }}
        />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="ox-tour-title"
        aria-describedby="ox-tour-content"
        data-tour-step={step.id}
        data-tour-state={!onPage ? 'elsewhere' : rect ? 'found' : missing ? 'missing' : 'waiting'}
        onKeyDown={onCardKey}
        style={{ ...cardStyle, zIndex: 9991, padding: '1rem', borderRadius: 'var(--ox-radius-lg)', background: 'var(--ox-surface-panel)', color: 'var(--ox-text-primary)', border: '1px solid var(--ox-border-strong)', boxShadow: 'var(--ox-shadow-lg)', display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 'calc(100vw - 1.5rem)' }}
      >
        <div style={{ fontSize: '0.75rem', color: 'var(--ox-text-secondary)' }}>
          {tour.title} · step {index + 1} of {total}
        </div>
        <h2 id="ox-tour-title" ref={headingRef} tabIndex={-1} style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
          {step.title}
        </h2>
        <p id="ox-tour-content" style={{ margin: 0, fontSize: '0.875rem', lineHeight: 1.5 }}>
          {step.content}
        </p>
        {!onPage && (
          <p style={{ margin: 0, fontSize: '0.8125rem' }}>
            This step is on another page. <a href={stepHref(basePath, tour, index)}>Go to it</a>
          </p>
        )}
        {onPage && !rect && (
          <p role="status" style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--ox-text-secondary)' }}>
            {missing ? step.hint || 'The part this step describes is not on the page right now.' : step.hint || 'Looking for this part of the page...'}
          </p>
        )}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" style={btn} onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous step">
              Back
            </button>
            {index < total - 1 ? (
              <button type="button" style={{ ...btn, background: 'var(--ox-action-bg)', color: 'var(--ox-action-fg)', border: 'none' }} onClick={() => go(index + 1)} aria-label="Next step">
                Next
              </button>
            ) : (
              <button type="button" style={{ ...btn, background: 'var(--ox-action-bg)', color: 'var(--ox-action-fg)', border: 'none' }} onClick={end}>
                Finish tour
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" style={btn} onClick={pause}>
              Pause
            </button>
            <button type="button" style={btn} onClick={end} aria-label="End the tour">
              End
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
