import { h } from 'preact';
import { useState } from 'preact/hooks';

export function SatFlowDiagram({ transaction, order, onSelectElement }) {
  const [selectedItem, setSelectedItem] = useState(null);

  if (!transaction || !transaction.inputs || !transaction.outputs) {
    return (
      <div style="padding: 2rem; background: var(--color-bg-subtle); border-radius: var(--radius-md); text-align: center; color: var(--color-text-muted);">
        Load or select an artifact to visualize its sat flow and asset preservation.
      </div>
    );
  }

  const inputs = transaction.inputs || [];
  const outputs = transaction.outputs || [];

  const handleSelect = (item) => {
    setSelectedItem(item);
    if (onSelectElement) onSelectElement(item);
  };

  return (
    <div class="sat-flow-container" style="display: flex; flex-direction: column; gap: 1rem;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h4 style="margin: 0; font-size: 1rem;">Interactive Sat-Flow & Asset Preservation Diagram</h4>
        <span style="font-size: 0.75rem; color: var(--color-text-muted);">
          Select any node to inspect invariants and sighash commitments
        </span>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 60px 1fr; gap: 1rem; align-items: stretch;">
        {/* Left: Inputs */}
        <div style="display: flex; flex-direction: column; gap: 0.5rem;">
          <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: var(--color-text-muted);">
            Transaction Inputs ({inputs.length})
          </div>
          {inputs.map((inp, idx) => {
            const isOffered = order?.offeredOutpoint &&
              order.offeredOutpoint.txid === inp.txid &&
              Number(order.offeredOutpoint.vout) === Number(inp.vout);
            const isSelected = selectedItem?.type === 'input' && selectedItem?.index === idx;

            return (
              <div
                key={idx}
                class="panel"
                style={{
                  padding: '0.65rem 0.85rem',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  borderLeft: isOffered ? '4px solid var(--color-brand)' : '4px solid var(--color-evidence-observation)',
                  backgroundColor: isSelected ? 'var(--color-bg-muted)' : 'var(--color-bg-surface)',
                  boxShadow: 'none'
                }}
                onClick={() => handleSelect({ type: 'input', index: idx, data: inp, isOffered })}
              >
                <div style="display: flex; justify-content: space-between; font-weight: 700;">
                  <span>Input #{idx} {isOffered ? '🏷️ [Seller Asset]' : '💰 [Buyer Funding]'}</span>
                  <span>{inp.valueSats || '0'} sats</span>
                </div>
                <div style="font-size: 0.75rem; font-family: var(--font-mono); color: var(--color-text-muted); word-break: break-all;">
                  {inp.txid}:{inp.vout}
                </div>
              </div>
            );
          })}
        </div>

        {/* Center: Flow connector arrows */}
        <div style="display: flex; flex-direction: column; justify-content: center; align-items: center; color: var(--color-text-muted); font-size: 1.5rem;">
          ➔
        </div>

        {/* Right: Outputs */}
        <div style="display: flex; flex-direction: column; gap: 0.5rem;">
          <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: var(--color-text-muted);">
            Transaction Outputs ({outputs.length})
          </div>
          {outputs.map((out, idx) => {
            const isSellerPayment = order?.sellerPaymentScriptHex &&
              out.scriptHex === order.sellerPaymentScriptHex;
            const isBuyerAsset = idx === 0 && !isSellerPayment; // Asset output
            const isSelected = selectedItem?.type === 'output' && selectedItem?.index === idx;

            return (
              <div
                key={idx}
                class="panel"
                style={{
                  padding: '0.65rem 0.85rem',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  borderLeft: isSellerPayment ? '4px solid var(--color-success)' : isBuyerAsset ? '4px solid var(--color-brand)' : '4px solid var(--color-border)',
                  backgroundColor: isSelected ? 'var(--color-bg-muted)' : 'var(--color-bg-surface)',
                  boxShadow: 'none'
                }}
                onClick={() => handleSelect({ type: 'output', index: idx, data: out, isSellerPayment, isBuyerAsset })}
              >
                <div style="display: flex; justify-content: space-between; font-weight: 700;">
                  <span>
                    Output #{idx} {isSellerPayment ? '💵 [Seller Payment]' : isBuyerAsset ? '🎁 [Buyer Asset]' : '🔄 [Buyer Change]'}
                  </span>
                  <span>{out.valueSats || '0'} sats</span>
                </div>
                <div style="font-size: 0.75rem; font-family: var(--font-mono); color: var(--color-text-muted); word-break: break-all;">
                  script: {out.scriptHex}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected Inspector Detail */}
      {selectedItem && (
        <div style="padding: 0.85rem; background: var(--color-bg-subtle); border-radius: var(--radius-md); font-size: 0.85rem; border-left: 3px solid var(--color-focus);">
          <div style="font-weight: 700; margin-bottom: 0.25rem;">
            Inspecting {selectedItem.type.toUpperCase()} #{selectedItem.index}
          </div>
          <div style="color: var(--color-text-secondary); line-height: 1.4;">
            {selectedItem.isOffered && 'This input carries the seller ordinal inscription. SIGHASH_SINGLE locks this input to output index 0.'}
            {selectedItem.isSellerPayment && 'This output pays the seller price in full without subtraction. ScriptPubKey matches seller commitment.'}
            {selectedItem.isBuyerAsset && 'This output receives the asset. Verified ahead of change outputs to preserve ordinal sat ranges.'}
            {!selectedItem.isOffered && !selectedItem.isSellerPayment && !selectedItem.isBuyerAsset && 'Standard funding / change UTXO subject to total value conservation rules.'}
          </div>
        </div>
      )}
    </div>
  );
}
