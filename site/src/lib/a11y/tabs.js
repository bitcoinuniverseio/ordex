// Keyboard behavior for a WAI-ARIA tablist (APG "Tabs" pattern, automatic activation):
// Left/Right move between tabs, Home/End jump to the ends, focus follows the selection.

export function tabKeyHandler(ids, activeId, setActive, idPrefix) {
  return (event) => {
    const index = ids.indexOf(activeId);
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = ids[(index + 1) % ids.length];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = ids[(index - 1 + ids.length) % ids.length];
    else if (event.key === 'Home') next = ids[0];
    else if (event.key === 'End') next = ids[ids.length - 1];
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    if (idPrefix && typeof document !== 'undefined') {
      const el = document.getElementById(`${idPrefix}-tab-${next}`);
      if (el) el.focus();
    }
  };
}

/** Props for one tab button in a tablist. */
export function tabProps(idPrefix, id, activeId, setActive, onKeyDown) {
  const selected = id === activeId;
  return {
    id: `${idPrefix}-tab-${id}`,
    role: 'tab',
    type: 'button',
    'aria-selected': selected ? 'true' : 'false',
    'aria-controls': `${idPrefix}-panel-${id}`,
    tabIndex: selected ? 0 : -1,
    onClick: () => setActive(id),
    onKeyDown
  };
}

/** Props for the panel a tab controls. */
export function tabPanelProps(idPrefix, id) {
  return {
    id: `${idPrefix}-panel-${id}`,
    role: 'tabpanel',
    'aria-labelledby': `${idPrefix}-tab-${id}`,
    tabIndex: 0
  };
}
