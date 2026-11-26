import { counterpartyRecordDigest, sortedJson, verifyCounterpartyUtxoAsset } from '../verifier/counterparty-asset.js';
import { ATOMIC, isRecord, PositionError } from './upstream.mjs';

function knownFields(value, required, optional = []) {
  return isRecord(value) && required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function assetDeclaration({ name, assetId, quantitySats }) {
  return { name, assetId, quantitySats };
}

export function mapAttachments(records, { network, txid, vout, snapshot, output }) {
  const byId = new Map();
  for (const record of records) {
    if (!verifyCounterpartyUtxoAsset(record).ok ||
        !knownFields(record, [
          'schema', 'network', 'asset', 'outpoint', 'address', 'sourceValueSats',
          'coTravelingAssets', 'checkpoint', 'authority', 'attached',
        ], ['digest']) ||
        !knownFields(record.asset, ['name', 'assetId', 'divisible', 'quantitySats'], ['issuer']) ||
        (Object.hasOwn(record.asset, 'issuer') && typeof record.asset.issuer !== 'string') ||
        !knownFields(record.outpoint, ['txid', 'vout']) ||
        !knownFields(record.checkpoint, ['height', 'blockHash', 'ledgerHash']) ||
        !knownFields(record.authority, ['kind', 'ready']) ||
        (Object.hasOwn(record, 'digest') && record.digest !== counterpartyRecordDigest(record)) ||
        record.network !== network || record.outpoint.txid !== txid || record.outpoint.vout !== vout ||
        record.checkpoint.height !== snapshot.height || record.checkpoint.blockHash !== snapshot.blockHash ||
        record.checkpoint.ledgerHash !== snapshot.ledgerHash ||
        record.sourceValueSats !== output.valueSats || output.valueSats === '0' ||
        record.address !== output.address || !Array.isArray(record.coTravelingAssets)) {
      throw new PositionError('counterparty_attachment_unproven');
    }
    const { assetId, quantitySats } = record.asset;
    if (assetId.length > 512 || !ATOMIC.test(quantitySats) || quantitySats === '0' || byId.has(assetId)) {
      throw new PositionError('counterparty_attachment_unrepresentable');
    }
    byId.set(assetId, record);
  }

  const ids = [...byId.keys()].sort((a, b) => a.localeCompare(b));
  const declarations = new Map(ids.map((id) => [id, sortedJson(assetDeclaration(byId.get(id).asset))]));
  const positions = ids.map((assetId) => {
    const { asset, coTravelingAssets } = byId.get(assetId);
    const others = new Set();
    if (coTravelingAssets.length !== ids.length - 1) {
      throw new PositionError('counterparty_cotravel_unproven');
    }
    for (const other of coTravelingAssets) {
      if (!knownFields(other, ['name', 'assetId', 'quantitySats']) ||
          other.assetId === assetId || others.has(other.assetId) ||
          declarations.get(other.assetId) !== sortedJson(other)) {
        throw new PositionError('counterparty_cotravel_unproven');
      }
      others.add(other.assetId);
    }
    // The attachment follows the sat range start of its input.
    return { protocolId: 'ordex', assetId, quantityAtomic: asset.quantitySats, offsetAtomic: '0', spanAtomic: '1' };
  });
  return { positions, recordDigests: ids.map((id) => counterpartyRecordDigest(byId.get(id))) };
}
