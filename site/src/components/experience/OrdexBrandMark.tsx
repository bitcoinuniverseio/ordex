import type { JSX } from 'preact';

interface BrandProps {
  size?: number;
  showWordmark?: boolean;
  version?: string;
  className?: string;
}

export function OrdexBrandMark({
  size = 28,
  showWordmark = true,
  version = 'v1.2',
  className = ''
}: BrandProps): JSX.Element {
  return (
    <div
      class={`ox-brand ${className}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.625rem',
        textDecoration: 'none',
        color: 'inherit',
        userSelect: 'none'
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Ordex Protocol Mark"
        role="img"
      >
        <rect width="32" height="32" rx="6" fill="#1A1D20" />
        {/* Stylized Hexagonal Bitcoin-native Ordex Rune & Inscription Glyph */}
        <path
          d="M16 6L25 11.2V20.8L16 26L7 20.8V11.2L16 6Z"
          stroke="#F7931A"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {/* Inner Order Exchange Crossing Lines */}
        <path
          d="M12 14L20 18M20 14L12 18"
          stroke="#FFFFFF"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="16" cy="16" r="2" fill="#F7931A" />
      </svg>

      {showWordmark && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
          <span
            style={{
              fontWeight: 700,
              fontSize: '1.125rem',
              letterSpacing: '-0.02em',
              color: 'var(--ox-text-primary)'
            }}
          >
            Ordex
          </span>
          {version && (
            <span
              style={{
                fontSize: '0.6875rem',
                fontWeight: 600,
                padding: '0.125rem 0.375rem',
                borderRadius: 'var(--ox-radius-sm)',
                backgroundColor: 'var(--ox-surface-subtle)',
                color: 'var(--ox-text-muted)',
                border: '1px solid var(--ox-border-subtle)',
                letterSpacing: '0.02em'
              }}
            >
              {version}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
