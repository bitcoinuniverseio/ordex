import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { IconCopy, IconExternalLink, IconHelp } from './OrdexIcons.js';
import { contextEngine } from '../../lib/experience/context-engine.js';

interface PageActionsProps {
  title: string;
  sourceDoc?: string;
  className?: string;
}

export function PageActions({
  title,
  sourceDoc,
  className = ''
}: PageActionsProps): JSX.Element {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedMd, setCopiedMd] = useState(false);

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleCopyMarkdown = () => {
    const mainContent = document.getElementById('main-content')?.innerText || '';
    const md = `# ${title}\nSource: ${window.location.href}\n\n${mainContent}`;
    navigator.clipboard.writeText(md);
    setCopiedMd(true);
    setTimeout(() => setCopiedMd(false), 2000);
  };

  const handleExplainSection = () => {
    contextEngine.setContext({
      title,
      sourcePointer: sourceDoc
    });
  };

  return (
    <div
      class={`ox-page-actions ${className}`}
      role="region"
      aria-label="Page Actions"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.375rem 0',
        marginBottom: '1rem',
        fontSize: '0.75rem'
      }}
    >
      <button
        type="button"
        onClick={handleCopyLink}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.375rem',
          padding: '0.25rem 0.5rem',
          borderRadius: 'var(--ox-radius-sm)',
          border: '1px solid var(--ox-border-default)',
          background: 'var(--ox-surface-subtle)',
          color: 'var(--ox-text-secondary)',
          cursor: 'pointer'
        }}
      >
        <IconCopy size={13} />
        <span>{copiedLink ? 'Link Copied' : 'Copy Link'}</span>
      </button>

      <button
        type="button"
        onClick={handleCopyMarkdown}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.375rem',
          padding: '0.25rem 0.5rem',
          borderRadius: 'var(--ox-radius-sm)',
          border: '1px solid var(--ox-border-default)',
          background: 'var(--ox-surface-subtle)',
          color: 'var(--ox-text-secondary)',
          cursor: 'pointer'
        }}
      >
        <IconCopy size={13} />
        <span>{copiedMd ? 'Markdown Copied' : 'Copy as Markdown'}</span>
      </button>

      <button
        type="button"
        onClick={handleExplainSection}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.375rem',
          padding: '0.25rem 0.5rem',
          borderRadius: 'var(--ox-radius-sm)',
          border: '1px solid var(--ox-border-default)',
          background: 'var(--ox-surface-subtle)',
          color: 'var(--ox-text-secondary)',
          cursor: 'pointer'
        }}
      >
        <IconHelp size={13} />
        <span>Explain Section</span>
      </button>

      {sourceDoc && (
        <a
          href={`https://github.com/bitcoinuniverseio/ordex/blob/develop/${sourceDoc}`}
          target="_blank"
          rel="noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.375rem',
            padding: '0.25rem 0.5rem',
            borderRadius: 'var(--ox-radius-sm)',
            border: '1px solid var(--ox-border-default)',
            background: 'var(--ox-surface-subtle)',
            color: 'var(--ox-text-secondary)',
            textDecoration: 'none'
          }}
        >
          <IconExternalLink size={13} />
          <span>Authoritative Source</span>
        </a>
      )}
    </div>
  );
}
