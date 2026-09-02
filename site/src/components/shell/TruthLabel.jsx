import { h } from 'preact';

export function TruthLabel({ level }) {
  const configs = {
    'Chain proof': {
      class: 'badge-proof',
      icon: '⛓️',
      description: 'Established directly by Bitcoin consensus or cryptographically immutable proof.'
    },
    'Protocol verification': {
      class: 'badge-verification',
      icon: '🛡️',
      description: 'Validated deterministically by the Ordex reference verifier rules.'
    },
    'Gateway observation': {
      class: 'badge-observation',
      icon: '📡',
      description: 'Information observed and reported by an Ordex gateway.'
    },
    'Publisher claim': {
      class: 'badge-claim',
      icon: '📝',
      description: 'Information asserted by an order or artifact author, subject to verification.'
    },
    'Deterministic example': {
      class: 'badge-example',
      icon: '🧪',
      description: 'Generated from checked-in test fixtures and protocol contracts.'
    }
  };

  const config = configs[level] || configs['Deterministic example'];

  return (
    <span
      class={`badge ${config.class}`}
      title={config.description}
      aria-label={`Evidence level: ${level}`}
    >
      <span aria-hidden="true">{config.icon}</span>
      <span>{level}</span>
    </span>
  );
}
