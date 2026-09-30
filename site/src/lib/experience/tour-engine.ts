/**
 * Ordex guided tours (OX-S10).
 *
 * One manifest (tours.json) drives the live tour overlay, the tour page and the screenshot
 * capture script. Every step names the page it runs on and a `data-tour` target on that page;
 * the overlay highlights the real element there. Screenshots, when present, come from
 * scripts/capture-walkthroughs.mjs driving the built site in a browser (tourCaptures.json);
 * nothing is drawn or simulated.
 */

import toursData from './tours.json';
import capturesData from '../../data/tourCaptures.json';

export interface TourStep {
  id: string;
  route: string;
  target: string;
  title: string;
  content: string;
  /** Shown while the target is not on the page yet (it appears after an interaction). */
  hint?: string;
}

export interface TourDefinition {
  id: string;
  title: string;
  summary: string;
  relatedMissionId: string | null;
  steps: TourStep[];
}

export interface TourCapture {
  variant: 'desktop-light' | 'desktop-dark' | 'mobile-light';
  file: string;
  sha256: string;
  width: number;
  height: number;
  hotspot: { x: number; y: number; width: number; height: number };
}

export const PRODUCT_TOURS: TourDefinition[] = toursData as TourDefinition[];

const captures = capturesData as { schema: string; revision: string | null; capturedAt: string | null; captures: Record<string, TourCapture[]> };
export const CAPTURE_REVISION = captures.revision;

export function getTourById(id: string | null | undefined): TourDefinition | undefined {
  return PRODUCT_TOURS.find((t) => t.id === id);
}

/** Screenshots captured from the real site for one step, possibly none. */
export function capturesFor(tourId: string, stepId: string): TourCapture[] {
  return captures.captures[`${tourId}/${stepId}`] || [];
}

/** The URL of a step: its page, with the tour and step in the query. */
export function stepHref(basePath: string, tour: TourDefinition, index: number): string {
  const step = tour.steps[index];
  const url = new URL(step.route, 'https://ordex.invalid');
  url.searchParams.set('tour', tour.id);
  url.searchParams.set('step', String(index + 1));
  return `${basePath}${url.pathname}${url.search}`;
}

/** The active tour from a query string, when the step exists. */
export function tourFromSearch(search: string): { tour: TourDefinition; index: number } | null {
  const params = new URLSearchParams(search);
  const tour = getTourById(params.get('tour'));
  const n = Number(params.get('step'));
  if (!tour || !Number.isInteger(n) || n < 1 || n > tour.steps.length) return null;
  return { tour, index: n - 1 };
}

/** True when the current location is the page a step runs on (path and its own query). */
export function onStepPage(step: TourStep, basePath: string, location: { pathname: string; search: string }): boolean {
  const want = new URL(step.route, 'https://ordex.invalid');
  const path = location.pathname.startsWith(basePath) ? location.pathname.slice(basePath.length) || '/' : location.pathname;
  const norm = (p: string) => (p.endsWith('/') ? p : `${p}/`);
  if (norm(path) !== norm(want.pathname)) return false;
  const have = new URLSearchParams(location.search);
  return [...want.searchParams.entries()].every(([k, v]) => have.get(k) === v);
}
