/**
 * Shared URL resolver guaranteeing all internal paths strictly use
 * the production /ordex/ base path on GitHub Pages and local development.
 */

export const BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL)
  ? import.meta.env.BASE_URL.replace(/\/$/, '')
  : '/ordex';

export function resolveUrl(path) {
  if (!path) return `${BASE_URL}/`;
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('#') || path.startsWith('mailto:')) {
    return path;
  }
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (clean.startsWith(`${BASE_URL}/`) || clean === BASE_URL) {
    return clean;
  }
  return `${BASE_URL}${clean}`;
}
