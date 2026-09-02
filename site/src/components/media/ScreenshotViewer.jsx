import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';

export function ScreenshotViewer({
  storyId,
  title,
  caption,
  liveUrl,
  width = 1200,
  height = 800,
  hotspots = []
}) {
  const [isZoomed, setIsZoomed] = useState(false);
  const [activeHotspot, setActiveHotspot] = useState(null);

  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') setIsZoomed(false);
    };
    if (isZoomed) window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isZoomed]);

  const placeholderSvg = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="%2318181b"/><text x="50%" y="45%" fill="%23f97316" font-size="28" font-family="system-ui" font-weight="bold" text-anchor="middle">Ordex Deterministic Capture</text><text x="50%" y="55%" fill="%23a1a1aa" font-size="18" font-family="system-ui" text-anchor="middle">Story: ${storyId}</text></svg>`;

  return (
    <figure class="screenshot-figure panel" style="padding: 1rem; margin: 1.5rem 0;">
      <div class="panel-header" style="margin-bottom: 0.5rem; padding-bottom: 0.5rem;">
        <div>
          <span style="font-size: 0.75rem; text-transform: uppercase; font-weight: 700; color: var(--color-text-muted);">
            Capture Story: <code>{storyId}</code>
          </span>
          <h4 style="margin: 0.2rem 0 0 0; font-size: 1rem;">{title}</h4>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          {liveUrl && (
            <a href={liveUrl} class="btn btn-secondary" style="font-size: 0.75rem; padding: 0.2rem 0.5rem; min-height: 28px;">
              Open Live State ↗
            </a>
          )}
          <button
            class="btn btn-outline"
            onClick={() => setIsZoomed(true)}
            style="font-size: 0.75rem; padding: 0.2rem 0.5rem; min-height: 28px;"
          >
            🔍 Expand
          </button>
        </div>
      </div>

      {/* Image with Hotspots */}
      <div style="position: relative; overflow: hidden; border-radius: var(--radius-md); background: var(--color-bg-subtle);">
        <img
          src={placeholderSvg}
          alt={title}
          width={width}
          height={height}
          loading="lazy"
          style="width: 100%; height: auto; display: block; border-radius: var(--radius-md);"
        />

        {/* Hotspots */}
        {hotspots.map((h, i) => (
          <button
            key={i}
            class="hotspot-pin"
            style={{
              position: 'absolute',
              top: `${h.top}%`,
              left: `${h.left}%`,
              width: '24px',
              height: '24px',
              borderRadius: '50%',
              backgroundColor: 'var(--color-brand)',
              color: '#ffffff',
              border: '2px solid #ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '12px',
              fontWeight: '700',
              cursor: 'pointer',
              transform: 'translate(-50%, -50%)',
              boxShadow: 'var(--shadow-md)'
            }}
            onClick={() => setActiveHotspot(activeHotspot === i ? null : i)}
            title={h.title}
            aria-label={`Hotspot ${i + 1}: ${h.title}`}
          >
            {i + 1}
          </button>
        ))}
      </div>

      {/* Hotspot detail popup */}
      {activeHotspot !== null && hotspots[activeHotspot] && (
        <div style="margin-top: 0.75rem; padding: 0.75rem; background: var(--color-brand-subtle); border: 1px solid var(--color-brand); border-radius: var(--radius-sm); font-size: 0.85rem;">
          <strong>#{activeHotspot + 1}: {hotspots[activeHotspot].title}</strong>
          <p style="margin: 0.25rem 0 0 0; color: var(--color-text-primary);">
            {hotspots[activeHotspot].description}
          </p>
        </div>
      )}

      {caption && (
        <figcaption style="margin-top: 0.5rem; font-size: 0.8rem; color: var(--color-text-muted); text-align: center;">
          {caption}
        </figcaption>
      )}

      {/* Zoom Modal */}
      {isZoomed && (
        <div
          style="position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.85); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem;"
          onClick={() => setIsZoomed(false)}
        >
          <div style="position: absolute; top: 1rem; right: 1.5rem; display: flex; gap: 1rem;">
            <button class="btn btn-secondary" onClick={() => setIsZoomed(false)}>
              Close (ESC)
            </button>
          </div>
          <img
            src={placeholderSvg}
            alt={title}
            style="max-width: 90vw; max-height: 85vh; object-fit: contain; border-radius: var(--radius-md);"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </figure>
  );
}
