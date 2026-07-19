const docs = [
  { href: 'index.html', label: 'Overview', group: 'Start', description: 'The portable orderbook and documentation map.' },
  { href: 'quickstart.html', label: 'Quickstart', group: 'Start', description: 'Choose a marketplace, operator, or collector path.' },
  { href: 'architecture.html', label: 'Architecture', group: 'Concepts', description: 'How evidence moves between Core, ord, Ordex, Nostr, and markets.' },
  { href: 'protocol-guide.html', label: 'Protocol', group: 'Concepts', description: 'Events, lifecycle states, verification, and settlement boundaries.' },
  { href: 'operator-guide.html', label: 'Operator guide', group: 'Build', description: 'Run a gateway beside Bitcoin Core and ord.' },
  { href: 'market-integration.html', label: 'Market integration', group: 'Build', description: 'Add portable inventory to a marketplace.' },
  { href: 'api-reference.html', label: 'API reference', group: 'Reference', description: 'Gateway endpoints, filters, and event flows.' },
  { href: 'troubleshooting.html', label: 'Troubleshooting', group: 'Reference', description: 'Trace a gateway, relay, asset, or visibility problem.' },
];

const currentPage = (() => {
  const name = window.location.pathname.split('/').pop();
  return name || 'index.html';
})();

function makeSearch() {
  const dialog = document.createElement('dialog');
  dialog.className = 'search-dialog';
  dialog.innerHTML = `
    <form method="dialog" class="search-panel">
      <div class="search-heading"><span>Navigate Ordex docs</span><button class="icon-button" value="cancel" aria-label="Close search">Esc</button></div>
      <label class="search-input"><span aria-hidden="true">⌕</span><input type="search" autocomplete="off" placeholder="Search guides, protocols, or operations" aria-label="Search documentation"></label>
      <div class="search-results" role="listbox"></div>
      <p class="search-hint"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>Enter</kbd> open <kbd>Esc</kbd> close</p>
    </form>`;
  document.body.append(dialog);

  const input = dialog.querySelector('input');
  const results = dialog.querySelector('.search-results');
  let selected = 0;
  let matches = docs;

  const draw = () => {
    results.innerHTML = matches.length ? matches.map((doc, index) => `
      <a class="search-result ${index === selected ? 'is-selected' : ''}" href="${doc.href}" role="option" aria-selected="${index === selected}">
        <span>${doc.group}</span><strong>${doc.label}</strong><small>${doc.description}</small>
      </a>`).join('') : '<p class="no-results">No guide matches that search.</p>';
  };
  const open = () => { dialog.showModal(); input.value = ''; matches = docs; selected = 0; draw(); window.setTimeout(() => input.focus(), 10); };

  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    matches = docs.filter((doc) => `${doc.label} ${doc.group} ${doc.description}`.toLowerCase().includes(query));
    selected = 0;
    draw();
  });
  input.addEventListener('keydown', (event) => {
    if (!matches.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); selected = (selected + 1) % matches.length; draw(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); selected = (selected - 1 + matches.length) % matches.length; draw(); }
    if (event.key === 'Enter') { event.preventDefault(); window.location.href = matches[selected].href; }
  });
  draw();
  return open;
}

function decorateNavigation() {
  const nav = document.querySelector('.nav');
  const links = nav?.querySelector('.navlinks');
  if (!nav || !links) return;
  nav.classList.add('docs-nav');
  [...links.querySelectorAll('a')].forEach((link) => {
    if (link.getAttribute('href') === currentPage) link.setAttribute('aria-current', 'page');
  });

  const search = makeSearch();
  const controls = document.createElement('div');
  controls.className = 'nav-controls';
  controls.innerHTML = '<button class="search-trigger" type="button"><span>Search docs</span><kbd>⌘ K</kbd></button><a class="repo-link" href="https://github.com/bitcoinuniverse/ordex" target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a>';
  controls.querySelector('.search-trigger').addEventListener('click', search);
  nav.append(controls);

  const toggle = document.createElement('button');
  toggle.className = 'menu-trigger';
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Open documentation navigation');
  toggle.innerHTML = '<span></span><span></span>';
  nav.insertBefore(toggle, controls);
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('menu-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); search(); }
    if (event.key === '/' && document.activeElement?.tagName !== 'INPUT') { event.preventDefault(); search(); }
  });
}

function decorateReadingExperience() {
  const progress = document.createElement('div');
  progress.className = 'reading-progress';
  document.body.append(progress);
  const updateProgress = () => {
    const height = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.transform = `scaleX(${height > 0 ? Math.min(window.scrollY / height, 1) : 0})`;
  };
  updateProgress();
  window.addEventListener('scroll', updateProgress, { passive: true });
  window.addEventListener('resize', updateProgress);

  document.querySelectorAll('.doc h2[id]').forEach((heading) => {
    const anchor = document.createElement('a');
    anchor.className = 'section-anchor';
    anchor.href = `#${heading.id}`;
    anchor.setAttribute('aria-label', `Link to ${heading.textContent}`);
    anchor.textContent = '#';
    heading.append(anchor);
  });

  const tocLinks = [...document.querySelectorAll('.toc a[href^="#"]')];
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const byId = new Map(tocLinks.map((link) => [link.getAttribute('href').slice(1), link]));
    const observer = new IntersectionObserver((entries) => {
      entries.filter((entry) => entry.isIntersecting).forEach((entry) => {
        tocLinks.forEach((link) => link.classList.remove('is-active'));
        byId.get(entry.target.id)?.classList.add('is-active');
      });
    }, { rootMargin: '-18% 0px -70% 0px', threshold: 0 });
    document.querySelectorAll('.doc section[id]').forEach((section) => observer.observe(section));
  }
}

function decorateCopyButtons() {
  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const code = document.querySelector(button.dataset.copy)?.innerText || '';
      const original = button.innerText;
      try { await navigator.clipboard.writeText(code); button.innerText = 'Copied'; }
      catch { button.innerText = 'Copy unavailable'; }
      window.setTimeout(() => { button.innerText = original; }, 1200);
    });
  });
}

decorateNavigation();
decorateReadingExperience();
decorateCopyButtons();
