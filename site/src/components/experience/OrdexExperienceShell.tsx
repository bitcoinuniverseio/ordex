import type { ComponentChildren, JSX } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { OrdexBrandMark } from './OrdexBrandMark.js';
import { CommandCenter } from './CommandCenter.js';
import { VersionEnvironmentController } from './VersionEnvironmentController.js';
import { ProgressiveDisclosureToggle } from './ProgressiveDisclosureToggle.js';
import { ContextRail } from './ContextRail.js';
import {
  IconLaunchpad,
  IconSandbox,
  IconInspect,
  IconDiagnose,
  IconDocs,
  IconAgents,
  IconChevronDown,
  IconChevronRight
} from './OrdexIcons.js';
import { journeyStore, type UserSettings } from '../../lib/session/journey-store.js';
import { contextEngine } from '../../lib/experience/context-engine.js';

interface ShellProps {
  currentRoute?: string;
  pageTitle?: string;
  children: ComponentChildren;
  basePath?: string;
}

export function OrdexExperienceShell({
  currentRoute = '/',
  pageTitle = 'Ordex Protocol Workspace',
  children,
  basePath = '/ordex'
}: ShellProps): JSX.Element {
  const [settings, setSettings] = useState<UserSettings>({
    disclosureMode: 'plain',
    protocolVersion: '1.2',
    environment: 'deterministic',
    customGatewayUrl: '',
    theme: 'light'
  });
  const [isContextRailOpen, setIsContextRailOpen] = useState(true);
  const [isDocsExpanded, setIsDocsExpanded] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    journeyStore.getSettings().then((s) => {
      setSettings(s);
      contextEngine.setContext({
        route: currentRoute,
        title: pageTitle,
        protocolVersion: s.protocolVersion,
        disclosureMode: s.disclosureMode
      });
    });
  }, [currentRoute, pageTitle]);

  const handleModeChange = (mode: 'plain' | 'builder' | 'proof') => {
    setSettings((prev) => ({ ...prev, disclosureMode: mode }));
    journeyStore.saveSettings({ disclosureMode: mode });
    contextEngine.setContext({ disclosureMode: mode });
  };

  const handleVersionChange = (ver: string) => {
    setSettings((prev) => ({ ...prev, protocolVersion: ver }));
    journeyStore.saveSettings({ protocolVersion: ver });
    contextEngine.setContext({ protocolVersion: ver });
  };

  const handleEnvChange = (env: string) => {
    setSettings((prev) => ({ ...prev, environment: env as UserSettings['environment'] }));
    journeyStore.saveSettings({ environment: env as UserSettings['environment'] });
  };

  const navItemStyle = (active: boolean) => ({
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    padding: '0.5rem 0.75rem',
    borderRadius: 'var(--ox-radius-md)',
    textDecoration: 'none',
    fontSize: '0.8125rem',
    fontWeight: active ? 600 : 500,
    backgroundColor: active ? 'var(--ox-surface-subtle)' : 'transparent',
    color: active ? 'var(--ox-text-primary)' : 'var(--ox-text-secondary)',
    borderLeft: active ? '3px solid var(--ox-bitcoin-orange)' : '3px solid transparent',
    transition: 'all 0.15s ease'
  });

  return (
    <div
      class="ox-app-shell"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        backgroundColor: 'var(--ox-surface-bg)',
        color: 'var(--ox-text-primary)',
        fontFamily: 'var(--ox-font-sans)'
      }}
    >
      {/* Global Header */}
      <header
        role="banner"
        style={{
          height: 'var(--ox-header-height)',
          backgroundColor: 'var(--ox-surface-panel)',
          borderBottom: '1px solid var(--ox-border-default)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 1.25rem',
          position: 'sticky',
          top: 0,
          zIndex: 100
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <a href={`${basePath}/`} style={{ textDecoration: 'none' }}>
            <OrdexBrandMark version={`v${settings.protocolVersion}`} />
          </a>

          <ProgressiveDisclosureToggle
            mode={settings.disclosureMode}
            onChange={handleModeChange}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <CommandCenter
            basePath={basePath}
            onSelectDisclosureMode={handleModeChange}
            onSelectProtocolVersion={handleVersionChange}
          />

          <VersionEnvironmentController
            version={settings.protocolVersion}
            onVersionChange={handleVersionChange}
            environment={settings.environment}
            onEnvironmentChange={handleEnvChange}
          />
        </div>
      </header>

      {/* Main 3-Pane Body Container */}
      <div
        style={{
          display: 'flex',
          flex: 1,
          overflow: 'hidden',
          minHeight: 'calc(100vh - var(--ox-header-height))'
        }}
      >
        {/* Left Navigation Rail (Desktop) */}
        <nav
          class="ox-left-nav"
          aria-label="Primary Navigation"
          style={{
            width: 'var(--ox-nav-width)',
            backgroundColor: 'var(--ox-surface-panel)',
            borderRight: '1px solid var(--ox-border-default)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: '1rem 0.75rem',
            flexShrink: 0
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <a
              href={`${basePath}/`}
              style={navItemStyle(currentRoute === '/' || currentRoute === '/start')}
            >
              <IconLaunchpad size={18} />
              <span>Launchpad</span>
            </a>

            <a
              href={`${basePath}/sandbox/`}
              style={navItemStyle(currentRoute.startsWith('/sandbox'))}
            >
              <IconSandbox size={18} />
              <span>Sandbox</span>
            </a>

            <a
              href={`${basePath}/inspect/`}
              style={navItemStyle(currentRoute.startsWith('/inspect'))}
            >
              <IconInspect size={18} />
              <span>Inspect</span>
            </a>

            <a
              href={`${basePath}/diagnose/`}
              style={navItemStyle(currentRoute.startsWith('/diagnose'))}
            >
              <IconDiagnose size={18} />
              <span>Diagnose</span>
            </a>

            <a
              href={`${basePath}/agents/`}
              style={navItemStyle(currentRoute.startsWith('/agents'))}
            >
              <IconAgents size={18} />
              <span>Agents (MCP)</span>
            </a>

            {/* Docs Hierarchy with Submenu */}
            <div style={{ marginTop: '0.5rem' }}>
              <button
                type="button"
                onClick={() => setIsDocsExpanded(!isDocsExpanded)}
                style={{
                  ...navItemStyle(currentRoute.startsWith('/learn') || currentRoute.startsWith('/build') || currentRoute.startsWith('/reference')),
                  width: '100%',
                  cursor: 'pointer',
                  border: 'none',
                  justifyContent: 'space-between'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                  <IconDocs size={18} />
                  <span>Documentation</span>
                </div>
                {isDocsExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
              </button>

              {isDocsExpanded && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.125rem',
                    paddingLeft: '1.75rem',
                    marginTop: '0.25rem',
                    fontSize: '0.75rem'
                  }}
                >
                  <a href={`${basePath}/learn`} style={{ padding: '0.35rem', color: 'var(--ox-text-secondary)', textDecoration: 'none' }}>Learn</a>
                  <a href={`${basePath}/build`} style={{ padding: '0.35rem', color: 'var(--ox-text-secondary)', textDecoration: 'none' }}>Build</a>
                  <a href={`${basePath}/lab`} style={{ padding: '0.35rem', color: 'var(--ox-text-secondary)', textDecoration: 'none' }}>Protocol Lab</a>
                  <a href={`${basePath}/verify`} style={{ padding: '0.35rem', color: 'var(--ox-text-secondary)', textDecoration: 'none' }}>Conformance</a>
                  <a href={`${basePath}/atlas`} style={{ padding: '0.35rem', color: 'var(--ox-text-secondary)', textDecoration: 'none' }}>Protocol Atlas</a>
                  <a href={`${basePath}/kits`} style={{ padding: '0.35rem', color: 'var(--ox-text-secondary)', textDecoration: 'none' }}>Kits</a>
                  <a href={`${basePath}/reference`} style={{ padding: '0.35rem', color: 'var(--ox-text-secondary)', textDecoration: 'none' }}>API & Specs</a>
                  <a href={`${basePath}/releases`} style={{ padding: '0.35rem', color: 'var(--ox-text-secondary)', textDecoration: 'none' }}>Releases</a>
                  <a href={`${basePath}/insights`} style={{ padding: '0.35rem', color: 'var(--ox-text-secondary)', textDecoration: 'none' }}>Insights</a>
                </div>
              )}
            </div>
          </div>

          {/* Mission Resume Banner */}
          <div
            style={{
              padding: '0.75rem',
              borderRadius: 'var(--ox-radius-md)',
              backgroundColor: 'var(--ox-surface-subtle)',
              border: '1px solid var(--ox-border-subtle)',
              fontSize: '0.75rem'
            }}
          >
            <div style={{ fontWeight: 700, color: 'var(--ox-text-muted)', textTransform: 'uppercase', fontSize: '0.625rem' }}>
              Trust Boundary
            </div>
            <div style={{ color: 'var(--ox-text-secondary)', marginTop: '0.25rem', lineHeight: 1.3 }}>
              Zero wallet signing. Zero private keys. All verifiers execute locally in your browser.
            </div>
          </div>
        </nav>

        {/* Center Main Stage */}
        <main
          id="main-content"
          role="main"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '1.5rem 2rem',
            maxWidth: '1280px',
            margin: '0 auto',
            width: '100%',
            boxSizing: 'border-box'
          }}
        >
          {children}
        </main>

        {/* Right Collapsible Context Rail */}
        <ContextRail
          isOpen={isContextRailOpen}
          onToggle={() => setIsContextRailOpen(!isContextRailOpen)}
          basePath={basePath}
        />
      </div>

      {/* Mobile Bottom Navigation Bar */}
      <nav
        class="ox-mobile-nav"
        aria-label="Mobile Navigation"
        style={{
          display: 'none',
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          height: 'var(--ox-mobile-nav-height)',
          backgroundColor: 'var(--ox-surface-panel)',
          borderTop: '1px solid var(--ox-border-default)',
          alignItems: 'center',
          justifyContent: 'space-around',
          zIndex: 90
        }}
      >
        <a href={`${basePath}/`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: '0.6875rem', textDecoration: 'none', color: 'var(--ox-text-secondary)' }}>
          <IconLaunchpad size={20} />
          <span>Start</span>
        </a>
        <a href={`${basePath}/sandbox/`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: '0.6875rem', textDecoration: 'none', color: 'var(--ox-text-secondary)' }}>
          <IconSandbox size={20} />
          <span>Sandbox</span>
        </a>
        <a href={`${basePath}/inspect/`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: '0.6875rem', textDecoration: 'none', color: 'var(--ox-text-secondary)' }}>
          <IconInspect size={20} />
          <span>Inspect</span>
        </a>
        <a href={`${basePath}/diagnose/`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: '0.6875rem', textDecoration: 'none', color: 'var(--ox-text-secondary)' }}>
          <IconDiagnose size={20} />
          <span>Diagnose</span>
        </a>
        <a href={`${basePath}/agents/`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: '0.6875rem', textDecoration: 'none', color: 'var(--ox-text-secondary)' }}>
          <IconAgents size={20} />
          <span>Agents</span>
        </a>
      </nav>

      <style>{`
        @media (max-width: 768px) {
          .ox-left-nav { display: none !important; }
          .ox-context-rail { display: none !important; }
          .ox-mobile-nav { display: flex !important; }
          main#main-content { padding-bottom: calc(var(--ox-mobile-nav-height) + 1rem) !important; }
        }
      `}</style>
    </div>
  );
}
