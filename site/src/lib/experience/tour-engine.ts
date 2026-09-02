/**
 * Ordex Accessible Product Tour Engine
 * 
 * Lightweight, accessible in-product walkthrough engine targeting real DOM elements.
 * Supports keyboard navigation, screen reader announcements, pause/resume, and static capture fallback.
 */

export interface TourStep {
  id: string;
  targetSelector: string;
  title: string;
  content: string;
  placement: 'top' | 'bottom' | 'left' | 'right';
  badge?: string;
}

export interface TourDefinition {
  id: string;
  title: string;
  summary: string;
  relatedMissionId?: string;
  steps: TourStep[];
  captures: {
    desktopLight: string;
    desktopDark: string;
    mobileLight: string;
  };
}

export const PRODUCT_TOURS: TourDefinition[] = [
  {
    id: 'tour-overview',
    title: 'Ordex Overview & Trust Boundaries',
    summary: 'Discover the task-first workspace, local Web Worker verifiers, and non-custodial boundaries.',
    steps: [
      {
        id: 'step-brand',
        targetSelector: '.ox-brand',
        title: 'Ordex Protocol Workspace',
        content: 'Ordex provides portable orderbooks and deterministic settlement for Bitcoin digital artifacts.',
        placement: 'bottom',
        badge: 'Foundation'
      },
      {
        id: 'step-disclosure',
        targetSelector: '.ox-disclosure-toggle',
        title: 'Progressive Disclosure Modes',
        content: 'Switch between Plain English (outcomes), Builder (API fields), and Protocol Proof (exact byte invariants).',
        placement: 'bottom',
        badge: 'Modes'
      },
      {
        id: 'step-command',
        targetSelector: '.ox-command-trigger',
        title: 'Command Center',
        content: 'Press Cmd+K to jump to any mission, API endpoint, scenario, or refusal code instantly.',
        placement: 'bottom',
        badge: 'Shortcut'
      },
      {
        id: 'step-rail',
        targetSelector: '.ox-context-rail',
        title: 'Context Lens Rail',
        content: 'The right rail continuously follows your active task, offering glossary definitions and verifier checks.',
        placement: 'left',
        badge: 'Context'
      }
    ],
    captures: {
      desktopLight: 'assets/tours/overview-desktop-light.png',
      desktopDark: 'assets/tours/overview-desktop-dark.png',
      mobileLight: 'assets/tours/overview-mobile-light.png'
    }
  },
  {
    id: 'tour-public-asks',
    title: 'Publish & Settle Public Asks',
    summary: 'Walk through how a seller lists an inscription and a buyer funds the purchase without custodian escrow.',
    relatedMissionId: 'integrate-public-asks',
    steps: [
      {
        id: 'step-mission-stage',
        targetSelector: 'nav[aria-label="Mission Stages"]',
        title: 'Standard 8-Stage Model',
        content: 'Missions guide you through Understand, Prepare, Simulate, Inspect, Verify, Integrate, Validate, Finish.',
        placement: 'bottom'
      },
      {
        id: 'step-target-tool',
        targetSelector: '.ox-app-shell',
        title: 'Integrated Tool Adapters',
        content: 'Structured parameters transfer between Wizards, Protocol Lab, and Sandbox without copy-pasting.',
        placement: 'top'
      }
    ],
    captures: {
      desktopLight: 'assets/tours/public-asks-desktop-light.png',
      desktopDark: 'assets/tours/public-asks-desktop-dark.png',
      mobileLight: 'assets/tours/public-asks-mobile-light.png'
    }
  },
  {
    id: 'tour-wallet-mutations',
    title: 'Inspect Wallet Mutations in Artifact Lens',
    summary: 'Detect output reordering, dropped proprietary keys, and sighash downgrades before signing.',
    steps: [
      {
        id: 'step-inspect-tabs',
        targetSelector: 'div[role="tablist"]',
        title: 'Synchronized Inspection Views',
        content: 'Explore Summary, Structure AST, Synchronized Bytes, and Mutation Lab comparison.',
        placement: 'bottom'
      }
    ],
    captures: {
      desktopLight: 'assets/tours/wallet-mutations-desktop-light.png',
      desktopDark: 'assets/tours/wallet-mutations-desktop-dark.png',
      mobileLight: 'assets/tours/wallet-mutations-mobile-light.png'
    }
  },
  {
    id: 'tour-failure-diagnose',
    title: 'Diagnose Protocol Failures',
    summary: 'Map refusal codes to violated invariants and generate minimal deterministic reproducers.',
    steps: [
      {
        id: 'step-diag-input',
        targetSelector: 'input[placeholder*="Enter refusal code"]',
        title: 'Automated Input Detection',
        content: 'Paste refusal codes, verifier envelopes, or HTTP error responses for deterministic triage.',
        placement: 'bottom'
      }
    ],
    captures: {
      desktopLight: 'assets/tours/diagnose-desktop-light.png',
      desktopDark: 'assets/tours/diagnose-desktop-dark.png',
      mobileLight: 'assets/tours/diagnose-mobile-light.png'
    }
  },
  {
    id: 'tour-agent-bridge',
    title: 'Connect AI Coding Agents (MCP)',
    summary: 'Configure Claude Code, Cursor, or Codex over local stdio or modern Streamable HTTP.',
    steps: [
      {
        id: 'step-mcp-explorer',
        targetSelector: '.ox-app-shell',
        title: 'MCP 2026-07-28 Tool Explorer',
        content: 'Inspect all 10 read-only tools and test live in-browser execution.',
        placement: 'top'
      }
    ],
    captures: {
      desktopLight: 'assets/tours/agent-bridge-desktop-light.png',
      desktopDark: 'assets/tours/agent-bridge-desktop-dark.png',
      mobileLight: 'assets/tours/agent-bridge-mobile-light.png'
    }
  }
];

export function getTourById(id: string): TourDefinition | undefined {
  return PRODUCT_TOURS.find(t => t.id === id);
}
