import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import atlasData from '../../data/atlas.json';
import { TruthLabel } from '../shell/TruthLabel.jsx';

export function VisualProtocolAtlas({ initialDiagramId = null }) {
  const [selectedDiagramId, setSelectedDiagramId] = useState(initialDiagramId || atlasData[0]?.id);
  const [currentStep, setCurrentStep] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeSidePanel, setActiveSidePanel] = useState('wire'); // 'wire', 'verifier', 'transcript'

  const diagram = atlasData.find((d) => d.id === selectedDiagramId) || atlasData[0];
  const steps = diagram.steps || [];
  const activeStepObj = steps[currentStep] || steps[0];

  // Auto playback
  useEffect(() => {
    let timer = null;
    if (isPlaying) {
      timer = setInterval(() => {
        setCurrentStep((prev) => {
          if (prev >= steps.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 2500);
    }
    return () => clearInterval(timer);
  }, [isPlaying, steps.length]);

  const handlePrev = () => {
    setCurrentStep((prev) => Math.max(0, prev - 1));
  };

  const handleNext = () => {
    setCurrentStep((prev) => Math.min(steps.length - 1, prev + 1));
  };

  const exportSvg = () => {
    const svgEl = document.getElementById('protocol-atlas-svg');
    if (!svgEl) return;
    const serializer = new XMLSerializer();
    const source = serializer.serializeToString(svgEl);
    const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${diagram.id}-step-${currentStep + 1}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div class="atlas-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      {/* Diagram Selector */}
      <div class="panel" style="padding: 1rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <h3 style="margin: 0; font-size: 1.15rem;">Visual Protocol Atlas (16 Sequence Diagrams)</h3>
          <span style="font-size: 0.8rem; color: var(--color-text-muted);">Data-driven interactive visualizations</span>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 0.4rem;">
          {atlasData.map((d) => (
            <button
              key={d.id}
              class={`btn ${selectedDiagramId === d.id ? 'btn-primary' : 'btn-outline'}`}
              style="font-size: 0.75rem; min-height: 28px; padding: 0.2rem 0.6rem;"
              onClick={() => {
                setSelectedDiagramId(d.id);
                setCurrentStep(0);
                setIsPlaying(false);
              }}
            >
              {d.title}
            </button>
          ))}
        </div>
      </div>

      {/* Main Diagram Panel */}
      <div class="panel">
        <div class="panel-header">
          <div>
            <span class="badge badge-verification">Sequence View</span>
            <h2 style="margin: 0.25rem 0 0 0; font-size: 1.35rem;">{diagram.title}</h2>
            <p style="margin: 0.25rem 0 0 0; font-size: 0.9rem; color: var(--color-text-secondary);">
              {diagram.summary}
            </p>
          </div>

          {/* Playback Controls */}
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <button class="btn btn-outline" onClick={handlePrev} disabled={currentStep === 0}>
              ◀ Prev
            </button>
            <button class="btn btn-secondary" onClick={() => setIsPlaying(!isPlaying)}>
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </button>
            <button class="btn btn-outline" onClick={handleNext} disabled={currentStep === steps.length - 1}>
              Next ▶
            </button>
            <button class="btn btn-outline" onClick={exportSvg} title="Export current step as SVG">
              📥 SVG
            </button>
          </div>
        </div>

        {/* Actor Lanes & Step Visualization SVG */}
        <div style="background: var(--color-bg-subtle); border-radius: var(--radius-md); padding: 1.5rem; overflow-x: auto; margin-bottom: 1.5rem;">
          <svg
            id="protocol-atlas-svg"
            viewBox="0 0 900 240"
            style="width: 100%; min-width: 650px; height: auto;"
          >
            {/* Actor Headers */}
            {diagram.actors.map((actor, idx) => {
              const x = 75 + idx * (750 / Math.max(1, diagram.actors.length - 1));
              const isFrom = activeStepObj.from === actor;
              const isTo = activeStepObj.to === actor;

              return (
                <g key={actor}>
                  {/* Vertical Lane Line */}
                  <line
                    x1={x}
                    y1={45}
                    x2={x}
                    y2={220}
                    stroke="var(--color-border)"
                    stroke-width="2"
                    stroke-dasharray="4"
                  />
                  {/* Actor Box */}
                  <rect
                    x={x - 65}
                    y={10}
                    width={130}
                    height={35}
                    rx={6}
                    fill={isFrom || isTo ? 'var(--color-brand)' : 'var(--color-bg-surface)'}
                    stroke={isFrom || isTo ? 'var(--color-brand)' : 'var(--color-border)'}
                    stroke-width="2"
                  />
                  <text
                    x={x}
                    y={32}
                    text-anchor="middle"
                    fill={isFrom || isTo ? '#ffffff' : 'var(--color-text-primary)'}
                    font-size="12"
                    font-weight="700"
                    font-family="system-ui"
                  >
                    {actor}
                  </text>
                </g>
              );
            })}

            {/* Active Message Arrow */}
            {(() => {
              const fromIdx = diagram.actors.indexOf(activeStepObj.from);
              const toIdx = diagram.actors.indexOf(activeStepObj.to);
              if (fromIdx === -1 || toIdx === -1) return null;

              const x1 = 75 + fromIdx * (750 / Math.max(1, diagram.actors.length - 1));
              const x2 = 75 + toIdx * (750 / Math.max(1, diagram.actors.length - 1));
              const y = 110;

              return (
                <g>
                  <line
                    x1={x1}
                    y1={y}
                    x2={x2}
                    y2={y}
                    stroke="var(--color-brand)"
                    stroke-width="3"
                  />
                  {/* Arrowhead */}
                  <polygon
                    points={x1 < x2 ? `${x2},${y} ${x2 - 10},${y - 5} ${x2 - 10},${y + 5}` : `${x2},${y} ${x2 + 10},${y - 5} ${x2 + 10},${y + 5}`}
                    fill="var(--color-brand)"
                  />
                  {/* Step Label Box */}
                  <rect
                    x={Math.min(x1, x2) + Math.abs(x1 - x2) / 2 - 140}
                    y={y - 30}
                    width={280}
                    height={24}
                    rx={4}
                    fill="var(--color-bg-surface)"
                    stroke="var(--color-brand)"
                    stroke-width="1.5"
                  />
                  <text
                    x={Math.min(x1, x2) + Math.abs(x1 - x2) / 2}
                    y={y - 14}
                    text-anchor="middle"
                    fill="var(--color-text-primary)"
                    font-size="11"
                    font-weight="600"
                    font-family="system-ui"
                  >
                    Step {activeStepObj.step}: {activeStepObj.label.slice(0, 38)}
                  </text>
                </g>
              );
            })()}
          </svg>
        </div>

        {/* Step Details & Side Panels */}
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">
          {/* Left: Step Breakdown */}
          <div style="background: var(--color-bg-subtle); padding: 1.25rem; border-radius: var(--radius-md);">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
              <h4 style="margin: 0; font-size: 1rem;">
                Step {activeStepObj.step} of {steps.length}: {activeStepObj.label}
              </h4>
              <span class="badge badge-verification">Active Invariant</span>
            </div>
            <p style="margin: 0 0 1rem 0; font-size: 0.85rem; color: var(--color-text-secondary); line-height: 1.4;">
              Safety Guarantee: {activeStepObj.safety}
            </p>
            <div style="display: flex; gap: 0.5rem;">
              <a href="/lab" class="btn btn-secondary" style="font-size: 0.75rem; padding: 0.2rem 0.5rem;">
                Open in Protocol Lab 🔬
              </a>
              <a href="/build/playground" class="btn btn-secondary" style="font-size: 0.75rem; padding: 0.2rem 0.5rem;">
                Open Related API 🚀
              </a>
            </div>
          </div>

          {/* Right: Technical Inspector Tabs */}
          <div>
            <div style="display: flex; gap: 0.5rem; margin-bottom: 0.75rem;">
              <button
                class={`btn ${activeSidePanel === 'wire' ? 'btn-primary' : 'btn-outline'}`}
                style="font-size: 0.8rem; min-height: 30px; padding: 0.2rem 0.6rem;"
                onClick={() => setActiveSidePanel('wire')}
              >
                Wire Format
              </button>
              <button
                class={`btn ${activeSidePanel === 'verifier' ? 'btn-primary' : 'btn-outline'}`}
                style="font-size: 0.8rem; min-height: 30px; padding: 0.2rem 0.6rem;"
                onClick={() => setActiveSidePanel('verifier')}
              >
                Verifier Rule
              </button>
              <button
                class={`btn ${activeSidePanel === 'transcript' ? 'btn-primary' : 'btn-outline'}`}
                style="font-size: 0.8rem; min-height: 30px; padding: 0.2rem 0.6rem;"
                onClick={() => setActiveSidePanel('transcript')}
              >
                Text Transcript
              </button>
            </div>

            <div style="background: var(--color-bg-subtle); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.85rem; font-size: 0.85rem; max-height: 180px; overflow-y: auto;">
              {activeSidePanel === 'wire' && (
                <div>
                  <div style="font-family: var(--font-mono); font-size: 0.8em; color: var(--color-text-primary);">
                    // Wire payload for step {activeStepObj.step}:<br />
                    {JSON.stringify({
                      action: activeStepObj.label,
                      sourceActor: activeStepObj.from,
                      destinationActor: activeStepObj.to,
                      enforcedBy: 'Ordex Engine v1.2'
                    }, null, 2)}
                  </div>
                </div>
              )}

              {activeSidePanel === 'verifier' && (
                <div>
                  <strong>Enforced Verifier Check:</strong>
                  <p style="margin: 0.25rem 0 0 0; color: var(--color-text-secondary);">
                    Rule: {activeStepObj.safety}. Handled deterministically by verifier in browser Web Worker.
                  </p>
                </div>
              )}

              {activeSidePanel === 'transcript' && (
                <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                  {steps.map((st) => (
                    <div key={st.step} style={{ color: st.step === activeStepObj.step ? 'var(--color-brand)' : 'var(--color-text-secondary)' }}>
                      <strong>{st.step}.</strong> {st.from} ➔ {st.to}: {st.label}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
