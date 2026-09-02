import { h } from 'preact';
import { useState } from 'preact/hooks';
import operationsData from '../../data/operations.json';
import { resolveUrl } from '../../lib/base-url.js';

export function RecipeViewer({ recipeId = 'publish-and-purchase' }) {
  const [activeTab, setActiveTab] = useState('sdk'); // sdk, ts, fetch, curl
  const [completedSteps, setCompletedSteps] = useState({});

  const sampleRecipes = [
    {
      id: 'publish-and-purchase',
      title: 'Recipe: Complete Public Ask Lifecycle',
      description: 'End-to-end operational recipe: build ask, publish signed PSBT, quote purchase, and preflight settlement.',
      steps: [
        {
          step: 1,
          name: 'Build Unsigned Public Ask',
          operationId: 'buildAsk',
          method: 'POST',
          path: '/api/ordex/orders/build',
          summary: 'Create the unsigned PSBT committing to the seller payment output.',
          requestPayload: {
            offeredOutpoint: {
              txid: '7b28f7a932b13c19e830e2f5b84c8a20984ef11320498a102938472910384729',
              vout: 0
            },
            priceSats: '150000',
            sellerPaymentScriptHex: '001438924b8923489123049182309481230948120394',
            assetClaim: {
              protocol: 'ordex',
              inscriptionId: '7b28f7a932b13c19e830e2f5b84c8a20984ef11320498a102938472910384729i0'
            }
          },
          expectedResponse: {
            orderId: 'ord_pub_98a72f1029384b',
            status: 'DRAFT',
            unsignedPsbtHex: '70736274ff010072...'
          },
          refusalCode: 'MALFORMED_ORDER',
          refusalExplanation: 'Returned if priceSats is not an exact decimal string or outpoint is invalid.'
        },
        {
          step: 2,
          name: 'Publish Signed Ask to Gateway',
          operationId: 'publishAsk',
          method: 'POST',
          path: '/api/ordex/orders/publish',
          summary: 'Submit the seller-signed PSBT (SIGHASH_SINGLE | ANYONECANPAY) to the catalog.',
          requestPayload: {
            orderId: 'ord_pub_98a72f1029384b',
            signedPsbtHex: '70736274ff01007202...'
          },
          expectedResponse: {
            orderId: 'ord_pub_98a72f1029384b',
            status: 'OPEN',
            publishedAt: '2026-09-02T16:00:00Z'
          },
          refusalCode: 'SELLER_OUTPUT_MISSING',
          refusalExplanation: 'Returned if seller signature does not commit to the matching payment index.'
        },
        {
          step: 3,
          name: 'Quote and Preflight Buyer Purchase',
          operationId: 'preflightOrder',
          method: 'POST',
          path: '/api/ordex/orders/ord_pub_98a72f1029384b/preflight',
          summary: 'Preflight the final settlement transaction to verify sat-flow and output positioning.',
          requestPayload: {
            buyerFundingOutpoints: [
              { txid: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', vout: 1, valueSats: '200000' }
            ],
            buyerReceiveScriptHex: '0014aabbccddeeff00112233445566778899aabbccdd'
          },
          expectedResponse: {
            ok: true,
            verdict: 'PASS',
            sharedIndex: 0,
            networkFeeSats: '3500'
          },
          refusalCode: 'SAT_FLOW_SHORTFALL',
          refusalExplanation: 'Returned if buyer funding inputs do not cover seller payment plus required network fee.'
        }
      ]
    }
  ];

  const recipe = sampleRecipes[0];

  const toggleStep = (sNum) => {
    setCompletedSteps((prev) => ({ ...prev, [sNum]: !prev[sNum] }));
  };

  const renderCodeSnippet = (step) => {
    const jsonBody = JSON.stringify(step.requestPayload, null, 2);

    if (activeTab === 'sdk') {
      return `import { OrdexClient } from '@bitcoinuniverse/ordex-sdk';

const client = new OrdexClient({ origin: 'http://localhost:8080' });

// ${step.name}
const res = await client.${step.operationId}(${jsonBody});
console.log('Result:', res);`;
    }

    if (activeTab === 'ts') {
      return `interface RequestPayload ${jsonBody.replace(/"/g, '')}

async function executeStep(): Promise<void> {
  const res = await fetch('http://localhost:8080${step.path}', {
    method: '${step.method}',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(${jsonBody})
  });
  const data = await res.json();
  console.log(data);
}`;
    }

    if (activeTab === 'fetch') {
      return `const res = await fetch('http://localhost:8080${step.path}', {
  method: '${step.method}',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(${jsonBody})
});
const data = await res.json();
console.log(data);`;
    }

    if (activeTab === 'curl') {
      return `curl -X ${step.method} "http://localhost:8080${step.path}" \\
  -H "Content-Type: application/json" \\
  -d '${jsonBody.replace(/\n/g, '').replace(/\s+/g, ' ')}'`;
    }

    return '';
  };

  return (
    <div class="recipe-container" style="display: flex; flex-direction: column; gap: 1.5rem;">
      <div class="panel">
        <div class="panel-header">
          <div>
            <span class="badge badge-verification">Executable Recipe</span>
            <h2 style="margin: 0.25rem 0 0 0; font-size: 1.3rem;">{recipe.title}</h2>
            <p style="margin: 0.25rem 0 0 0; color: var(--color-text-secondary); font-size: 0.9rem;">
              {recipe.description}
            </p>
          </div>
          {/* Code Tab Switcher */}
          <div style="display: flex; gap: 0.3rem;">
            {[
              { id: 'sdk', label: 'Ordex SDK' },
              { id: 'ts', label: 'TypeScript' },
              { id: 'fetch', label: 'JavaScript' },
              { id: 'curl', label: 'cURL' }
            ].map((t) => (
              <button
                key={t.id}
                class={`btn ${activeTab === t.id ? 'btn-primary' : 'btn-outline'}`}
                style="font-size: 0.8rem; min-height: 32px; padding: 0.2rem 0.6rem;"
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Steps List */}
        <div style="display: flex; flex-direction: column; gap: 2rem;">
          {recipe.steps.map((st) => {
            const isDone = completedSteps[st.step];
            return (
              <div
                key={st.step}
                class="recipe-step panel"
                style={{
                  padding: '1.25rem',
                  borderLeft: isDone ? '4px solid var(--color-success)' : '4px solid var(--color-brand)'
                }}
              >
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
                  <div style="display: flex; align-items: center; gap: 0.6rem;">
                    <span style="font-weight: 800; font-size: 1.1rem; color: var(--color-brand);">
                      0{st.step}
                    </span>
                    <h3 style="margin: 0; font-size: 1.1rem;">{st.name}</h3>
                    <code>{st.method} {st.path}</code>
                  </div>
                  <div style="display: flex; align-items: center; gap: 0.6rem;">
                    <button
                      class={`btn ${isDone ? 'btn-primary' : 'btn-outline'}`}
                      style="font-size: 0.75rem; min-height: 28px; padding: 0.15rem 0.5rem;"
                      onClick={() => toggleStep(st.step)}
                    >
                      {isDone ? '✓ Completed' : 'Mark Complete'}
                    </button>
                    <a
                      href={resolveUrl(`/reference/api/#${st.operationId}`)}
                      class="btn btn-secondary"
                      style="font-size: 0.75rem; min-height: 28px; padding: 0.15rem 0.5rem;"
                    >
                      Open in Playground 🚀
                    </a>
                  </div>
                </div>

                <p style="margin: 0 0 1rem 0; font-size: 0.85rem; color: var(--color-text-secondary);">
                  {st.summary}
                </p>

                {/* Code Sample */}
                <div style="margin-bottom: 1rem;">
                  <div style="font-size: 0.75rem; font-weight: 600; text-transform: uppercase; color: var(--color-text-muted); margin-bottom: 0.35rem;">
                    Executable Request ({activeTab.toUpperCase()})
                  </div>
                  <pre style="margin: 0;"><code>{renderCodeSnippet(st)}</code></pre>
                </div>

                {/* Expected Response & Refusal */}
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                  <div style="background: var(--color-bg-subtle); padding: 0.75rem; border-radius: var(--radius-md); border: 1px solid var(--color-border);">
                    <div style="font-size: 0.75rem; font-weight: 700; color: var(--color-success); margin-bottom: 0.35rem;">
                      Expected Success Response (200 OK)
                    </div>
                    <pre style="margin: 0; font-size: 0.8em; max-height: 120px;"><code>{JSON.stringify(st.expectedResponse, null, 2)}</code></pre>
                  </div>

                  <div style="background: var(--color-danger-bg); padding: 0.75rem; border-radius: var(--radius-md); border: 1px solid var(--color-danger);">
                    <div style="font-size: 0.75rem; font-weight: 700; color: var(--color-danger); margin-bottom: 0.35rem;">
                      Common Refusal: <code>{st.refusalCode}</code>
                    </div>
                    <p style="margin: 0; font-size: 0.8rem; color: var(--color-text-primary);">
                      {st.refusalExplanation}
                    </p>
                    <a
                      href={resolveUrl(`/reference/refusal-codes/#${st.refusalCode}`)}
                      style="display: inline-block; margin-top: 0.35rem; font-size: 0.75rem; color: var(--color-danger); font-weight: 600;"
                    >
                      View Refusal Specification →
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
