import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import corpusData from '../../data/corpus.json';
import operationsData from '../../data/operations.json';
import refusalsData from '../../data/refusals.json';
import specsData from '../../data/specs.json';
import wizardsData from '../../data/wizards.json';

export function GlobalSearch() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('all'); // all, api, wizards, refusals, specs
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentSearches, setRecentSearches] = useState([]);
  const inputRef = useRef(null);

  // Load recent searches
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('ordex_recent_searches') || '[]');
      setRecentSearches(saved);
    } catch (e) {}
  }, []);

  // Keyboard shortcut listener
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      } else if (e.key === '/' && !isOpen) {
        const active = document.activeElement;
        const isEditable = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
        if (!isEditable) {
          e.preventDefault();
          setIsOpen(true);
        }
      } else if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Filter items
  const q = query.trim().toLowerCase();
  const searchResults = [];

  if (q.length > 0) {
    // 1. API Operations
    if (activeFilter === 'all' || activeFilter === 'api') {
      for (const op of operationsData) {
        if (
          op.operationId.toLowerCase().includes(q) ||
          op.path.toLowerCase().includes(q) ||
          op.summary.toLowerCase().includes(q)
        ) {
          searchResults.push({
            type: 'API Operation',
            category: 'api',
            title: `${op.method} ${op.path}`,
            subtitle: `${op.operationId} - ${op.summary}`,
            url: `/reference/api/#${op.operationId}`,
            badge: op.authorityLevel
          });
        }
      }
    }

    // 2. Wizards & Workflows
    if (activeFilter === 'all' || activeFilter === 'wizards') {
      for (const w of wizardsData) {
        if (
          w.title.toLowerCase().includes(q) ||
          w.summary.toLowerCase().includes(q)
        ) {
          searchResults.push({
            type: 'Guided Workflow',
            category: 'wizards',
            title: w.title,
            subtitle: w.summary,
            url: `/build/wizards/#${w.id}`,
            badge: w.protocolScope
          });
        }
      }
    }

    // 3. Refusal Codes
    if (activeFilter === 'all' || activeFilter === 'refusals') {
      for (const ref of refusalsData) {
        if (
          ref.code.toLowerCase().includes(q) ||
          ref.explanation.toLowerCase().includes(q)
        ) {
          searchResults.push({
            type: 'Refusal Code',
            category: 'refusals',
            title: ref.code,
            subtitle: `${ref.category} - ${ref.explanation}`,
            url: `/reference/refusal-codes/#${ref.code}`,
            badge: ref.category
          });
        }
      }
    }

    // 4. Specifications
    if (activeFilter === 'all' || activeFilter === 'specs') {
      for (const s of specsData) {
        if (
          s.title.toLowerCase().includes(q) ||
          s.headings.some((h) => h.title.toLowerCase().includes(q))
        ) {
          searchResults.push({
            type: 'Specification',
            category: 'specs',
            title: s.title,
            subtitle: `spec/${s.file}`,
            url: `/reference/specifications/${s.id}`,
            badge: 'Spec'
          });
        }
      }
    }

    // 5. Corpus text
    for (const chunk of corpusData) {
      const linkUrl = chunk.docUrl || chunk.url;
      if (
        searchResults.length < 25 &&
        chunk.content.toLowerCase().includes(q) &&
        !searchResults.some((r) => r.url === linkUrl)
      ) {
        searchResults.push({
          type: chunk.contentType,
          category: 'docs',
          title: chunk.title,
          subtitle: chunk.content.slice(0, 100) + '...',
          url: linkUrl,
          badge: chunk.product
        });
      }
    }
  }

  const handleSelect = (url, term) => {
    if (term) {
      try {
        const nextRecent = [term, ...recentSearches.filter((t) => t !== term)].slice(0, 5);
        setRecentSearches(nextRecent);
        localStorage.setItem('ordex_recent_searches', JSON.stringify(nextRecent));
      } catch (e) {}
    }
    setIsOpen(false);
    window.location.href = url;
  };

  const handleKeyDownInResults = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, Math.max(0, searchResults.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (searchResults[selectedIndex]) {
        handleSelect(searchResults[selectedIndex].url, query);
      }
    }
  };

  return (
    <div>
      {/* Search trigger button in header */}
      <button
        class="btn btn-secondary"
        onClick={() => setIsOpen(true)}
        aria-label="Search documentation (Cmd+K)"
        style="padding: 0.4rem 0.8rem; font-size: 0.85rem; color: var(--color-text-secondary); display: flex; align-items: center; gap: 0.6rem; min-height: 36px; border-radius: var(--radius-md);"
      >
        <span aria-hidden="true">🔍</span>
        <span>Search documentation...</span>
        <kbd style="font-size: 0.75rem; background: var(--color-bg-muted); padding: 0.1rem 0.4rem; border-radius: 4px; border: 1px solid var(--color-border);">
          ⌘K
        </kbd>
      </button>

      {/* Modal Dialog */}
      {isOpen && (
        <div
          class="search-modal-backdrop"
          style="position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.6); display: flex; align-items: flex-start; justify-content: center; padding-top: 10vh;"
          onClick={() => setIsOpen(false)}
        >
          <div
            class="search-modal panel"
            style="width: 100%; max-width: 680px; max-height: 80vh; display: flex; flex-direction: column; padding: 0; overflow: hidden; box-shadow: var(--shadow-lg);"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Search Ordex Documentation"
          >
            {/* Search Input Bar */}
            <div style="display: flex; align-items: center; gap: 0.75rem; padding: 1rem 1.25rem; border-bottom: 1px solid var(--color-border);">
              <span style="font-size: 1.2rem; color: var(--color-text-muted);">🔍</span>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onInput={(e) => {
                  setQuery(e.target.value);
                  setSelectedIndex(0);
                }}
                onKeyDown={handleKeyDownInResults}
                placeholder="Search operations, guides, schemas, refusal codes, and vectors..."
                style="flex: 1; border: none; background: transparent; font-size: 1rem; color: var(--color-text-primary); outline: none;"
              />
              {query && (
                <button
                  class="btn btn-outline"
                  onClick={() => setQuery('')}
                  style="min-height: 28px; padding: 0.2rem 0.5rem; font-size: 0.75rem;"
                >
                  Clear
                </button>
              )}
              <button
                class="btn btn-outline"
                onClick={() => setIsOpen(false)}
                style="min-height: 28px; padding: 0.2rem 0.5rem; font-size: 0.75rem;"
              >
                ESC
              </button>
            </div>

            {/* Category Filter Pills */}
            <div style="display: flex; gap: 0.5rem; padding: 0.5rem 1.25rem; background: var(--color-bg-subtle); border-bottom: 1px solid var(--color-border); overflow-x: auto;">
              {[
                { id: 'all', label: 'All Content' },
                { id: 'api', label: 'API Ops (78)' },
                { id: 'wizards', label: 'Wizards (12)' },
                { id: 'refusals', label: 'Refusal Codes (172)' },
                { id: 'specs', label: 'Specifications (13)' }
              ].map((f) => (
                <button
                  key={f.id}
                  class={`btn ${activeFilter === f.id ? 'btn-primary' : 'btn-outline'}`}
                  style="min-height: 28px; padding: 0.15rem 0.6rem; font-size: 0.75rem; border-radius: var(--radius-full);"
                  onClick={() => setActiveFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Results Area */}
            <div style="flex: 1; overflow-y: auto; padding: 0.5rem 0; max-height: 55vh;">
              {q.length === 0 ? (
                <div style="padding: 1.5rem; color: var(--color-text-muted); font-size: 0.9rem;">
                  {recentSearches.length > 0 && (
                    <div style="margin-bottom: 1.5rem;">
                      <div style="font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem;">
                        Recent Searches
                      </div>
                      <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
                        {recentSearches.map((term) => (
                          <button
                            key={term}
                            class="btn btn-secondary"
                            style="min-height: 28px; padding: 0.2rem 0.6rem; font-size: 0.8rem;"
                            onClick={() => setQuery(term)}
                          >
                            {term}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div>
                    <div style="font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem;">
                      Quick Navigation
                    </div>
                    <ul style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.4rem;">
                      <li><a href="/build/playground">🚀 API and Real-Time Playground</a></li>
                      <li><a href="/lab">🔬 Ordex Protocol Lab</a></li>
                      <li><a href="/verify">⚖️ Conformance Studio and Gateway Doctor</a></li>
                      <li><a href="/atlas">🗺️ Visual Protocol Atlas</a></li>
                      <li><a href="/kits">📦 Integration Kit Generator</a></li>
                    </ul>
                  </div>
                </div>
              ) : searchResults.length === 0 ? (
                <div style="padding: 2rem; text-align: center; color: var(--color-text-muted);">
                  <p style="font-size: 1.1rem; margin: 0 0 0.5rem 0;">No matching documentation found for "{query}".</p>
                  <p style="font-size: 0.85rem; margin: 0 0 1rem 0;">Try searching for a refusal code, HTTP method, or protocol family.</p>
                  <a
                    href="https://github.com/bitcoinuniverseio/ordex/issues/new?title=Documentation+request+for+"
                    target="_blank"
                    rel="noreferrer"
                    class="btn btn-outline"
                    style="font-size: 0.85rem;"
                  >
                    Report Missing Documentation
                  </a>
                </div>
              ) : (
                <div>
                  {searchResults.slice(0, 20).map((res, i) => {
                    const isSelected = i === selectedIndex;
                    return (
                      <div
                        key={i}
                        class="search-result-item"
                        style={{
                          padding: '0.75rem 1.25rem',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '1rem',
                          backgroundColor: isSelected ? 'var(--color-bg-subtle)' : 'transparent',
                          borderLeft: isSelected ? '3px solid var(--color-brand)' : '3px solid transparent'
                        }}
                        onClick={() => handleSelect(res.url, query)}
                        onMouseEnter={() => setSelectedIndex(i)}
                      >
                        <div style="flex: 1; min-width: 0;">
                          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.2rem;">
                            <span style="font-size: 0.75rem; text-transform: uppercase; color: var(--color-text-muted); font-weight: 600;">
                              {res.type}
                            </span>
                            <span style="font-weight: 600; font-size: 0.95rem; color: var(--color-text-primary);">
                              {res.title}
                            </span>
                          </div>
                          <div style="font-size: 0.8rem; color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                            {res.subtitle}
                          </div>
                        </div>
                        {res.badge && (
                          <span class="badge badge-observation" style="font-size: 0.7rem;">
                            {res.badge}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style="padding: 0.6rem 1.25rem; border-top: 1px solid var(--color-border); background: var(--color-bg-subtle); display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; color: var(--color-text-muted);">
              <div>
                Use <kbd style="border: 1px solid var(--color-border); padding: 0.1rem 0.3rem; border-radius: 3px;">↑</kbd> <kbd style="border: 1px solid var(--color-border); padding: 0.1rem 0.3rem; border-radius: 3px;">↓</kbd> to navigate, <kbd style="border: 1px solid var(--color-border); padding: 0.1rem 0.3rem; border-radius: 3px;">Enter</kbd> to select
              </div>
              <div>
                {searchResults.length} results
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
