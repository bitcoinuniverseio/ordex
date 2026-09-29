import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import operationsData from '../../data/operations.json';
import { resolveUrl } from '../../lib/base-url.js';
import { RECIPES, getRecipe, sdkProgram, fetchProgram, curlCommands } from '../../lib/docs/recipes.mjs';
import { tabKeyHandler, tabProps, tabPanelProps } from '../../lib/a11y/tabs.js';

// OX-S11: recipes come from site/src/lib/docs/recipes.mjs. The three code views are generated
// from the same step definitions, so they never disagree; values from earlier responses are
// carried by name. "Read" marks are learning progress kept in this browser, not evidence that
// anything ran. ?recipe= opens a recipe by id; an unknown id is reported.

const TABS = [
  { id: 'sdk', label: 'SDK (TypeScript)' },
  { id: 'fetch', label: 'fetch (TypeScript)' },
  { id: 'curl', label: 'cURL and jq' }
];

const readKey = (id) => `ordex.recipe-read.${id}`;

export function RecipeViewer({ recipeId = RECIPES[0].id }) {
  const [id, setId] = useState(recipeId);
  const [unknown, setUnknown] = useState(null);
  const [tab, setTab] = useState('sdk');
  const [read, setRead] = useState({});
  const [announce, setAnnounce] = useState('');

  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('recipe');
    if (wanted && getRecipe(wanted)) setId(wanted);
    else if (wanted) setUnknown(wanted);
  }, []);

  useEffect(() => {
    try {
      setRead(JSON.parse(localStorage.getItem(readKey(id)) || '{}'));
    } catch {
      setRead({});
    }
  }, [id]);

  const recipe = getRecipe(id);
  const code = tab === 'sdk' ? sdkProgram(recipe) : tab === 'fetch' ? fetchProgram(recipe, operationsData) : curlCommands(recipe, operationsData);
  const onTabKey = tabKeyHandler(TABS.map((t) => t.id), tab, setTab, 'recipe');

  const toggleRead = (stepVar) => {
    const next = { ...read, [stepVar]: !read[stepVar] };
    setRead(next);
    try {
      localStorage.setItem(readKey(id), JSON.stringify(next));
    } catch {}
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setAnnounce('Code copied.');
    } catch {
      setAnnounce('Copying failed. Select the code and copy it yourself.');
    }
  };

  const choose = (next) => {
    setId(next);
    const url = new URL(window.location.href);
    url.searchParams.set('recipe', next);
    window.history.replaceState(null, '', url);
  };

  return (
    <div class="recipe-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      <div class="ox-sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      {unknown && (
        <p role="alert" style="margin: 0; color: var(--color-danger);">
          There is no recipe called "{unknown}". Showing {recipe.title}.
        </p>
      )}
      <div role="group" aria-label="Recipes" style="display: flex; gap: 0.4rem; flex-wrap: wrap;">
        {RECIPES.map((r) => (
          <button key={r.id} type="button" aria-pressed={r.id === id ? 'true' : 'false'} class={`btn ${r.id === id ? 'btn-primary' : 'btn-outline'}`} onClick={() => choose(r.id)}>
            {r.title}
          </button>
        ))}
      </div>

      <div class="panel">
        <h2 style="margin: 0; font-size: 1.3rem;">{recipe.title}</h2>
        <p style="margin: 0.25rem 0 1rem; color: var(--color-text-secondary); font-size: 0.9rem;">{recipe.summary}</p>

        <ol style="margin: 0 0 1.5rem; padding-left: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem;">
          {recipe.steps.map((s) => {
            const op = operationsData.find((o) => o.operationId === s.operationId);
            return (
              <li key={s.var}>
                <div style="display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem;">
                  <strong>{s.title}</strong>
                  <code style="font-size: 0.8rem; overflow-wrap: anywhere;">
                    {op.method} {op.path}
                  </code>
                </div>
                <p style="margin: 0.2rem 0; font-size: 0.875rem; color: var(--color-text-secondary);">{s.why}</p>
                <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
                  <a class="btn btn-secondary" style="font-size: 0.75rem; min-height: 28px; padding: 0.15rem 0.5rem;" href={resolveUrl(`/build/playground/?operation=${encodeURIComponent(s.operationId)}`)}>
                    Try {s.operationId} in the Playground
                  </a>
                  <label style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.8rem;">
                    <input type="checkbox" checked={!!read[s.var]} onChange={() => toggleRead(s.var)} />
                    I have read this step
                  </label>
                </div>
              </li>
            );
          })}
        </ol>

        <div role="tablist" aria-label="Code views" style="display: flex; gap: 0.3rem; flex-wrap: wrap; margin-bottom: 0.5rem;">
          {TABS.map((t) => (
            <button {...tabProps('recipe', t.id, tab, setTab, onTabKey)} class={`btn ${tab === t.id ? 'btn-primary' : 'btn-outline'}`} style="font-size: 0.8rem; min-height: 32px;">
              {t.label}
            </button>
          ))}
          <button type="button" class="btn btn-outline" style="font-size: 0.8rem; min-height: 32px; margin-left: auto;" onClick={copy}>
            Copy
          </button>
        </div>
        <div {...tabPanelProps('recipe', tab)}>
          <pre style="margin: 0; padding: 1rem; border-radius: var(--radius-md); background: var(--color-bg-subtle); overflow-x: auto; font-size: 0.8rem; line-height: 1.45;">
            <code>{code}</code>
          </pre>
        </div>
        <p style="margin: 0.75rem 0 0; font-size: 0.8rem; color: var(--color-text-secondary);">
          Set ORDEX_GATEWAY_ORIGIN to your gateway. The SDK is vendored in the starter kits from the Kits page. Values in the steps are examples that match the contract; use your own.
        </p>
      </div>
    </div>
  );
}
