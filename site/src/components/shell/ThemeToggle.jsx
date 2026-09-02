import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';

export function ThemeToggle() {
  const [theme, setTheme] = useState('light');

  useEffect(() => {
    try {
      const saved = localStorage.getItem('ordex_theme');
      if (saved) {
        setTheme(saved);
        document.documentElement.setAttribute('data-theme', saved);
      } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        setTheme('dark');
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    } catch (e) {}
  }, []);

  const toggle = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('ordex_theme', next);
    } catch (e) {}
  };

  return (
    <button
      class="btn btn-outline"
      onClick={toggle}
      title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      aria-label={`Current theme: ${theme}. Click to switch theme.`}
      style="padding: 0.4rem 0.6rem; min-height: 36px; min-width: 36px;"
    >
      <span aria-hidden="true">{theme === 'light' ? '🌙' : '☀️'}</span>
    </button>
  );
}
