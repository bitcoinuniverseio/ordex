# Cold signing and watch-only mode v1

Status: active at protocol 1.2. Artifacts: `ordex.expected-transaction-manifest/v1`, `ordex.offline-signing-session/v1`. Reference verifier: `verifier/offline-signing.js`. Vectors: `conformance/offline-signing-vectors.json`.

Cold signing is a signing mode, not a product silo: every transaction surface in Ordex, buys, listings, withdrawals, replacements, batch purchases, SafeOps, swaps, and heritage, can be completed through a connected wallet, a hardware wallet through its existing provider API, a PSBT file, base64 copy and paste, animated QR (crypto-psbt UR), or a static QR when the payload fits safely. Watch-only profiles can browse, plan, and export, and never imply they can sign.

## The SignerAdapter contract

One adapter interface with capability detection covers: connected-wallet signing (existing adapters), PSBT binary export and import, base64 copy and paste, animated QR through an established interoperable UR encoding, static QR fallback, hardware signing through audited wallet-provider APIs, and watch-only with no signing capability. No raw device key management exists anywhere in this codebase: keys and recovery material never pass through gateway, browser storage, or SDK.

PSBT v0 and v2 are supported where wallets require them. Conversion preserves the unsigned transaction, UTXO data, scripts, sighash policy, derivation metadata, and proprietary asset-protection fields, and refuses lossy conversions.

## The expected transaction manifest

Before any signing request, the flow builds a manifest: the network, one line stating the purpose, whether a watch-only profile prepared it, every input with its exact value and script, whether the user controls it, its sighash type, and one line on why it is spent, every output with its exact script, value, role, recipient, expected assets, and one line on who receives it, the fee and its permitted maximum, and the digest. The digest is SHA-256 over the sorted-key JSON of the network, the inputs (outpoint, value, script), the outputs (script, value), and the sighash policy. Presentation fields deliberately sit outside the digest; the unsigned transaction is the identity.

## The nine refusals

After a signed PSBT comes back, from any signer, the normalized result is compared against the manifest. The comparison refuses with a stable code when:

1. The signed result was not produced from this manifest (`MANIFEST_DIGEST_MISMATCH`).
2. The fee left its approved bound (`FEE_OUT_OF_BOUNDS`).
3. An input was added, removed, or reordered (`INPUT_SET_CHANGED`, `INPUT_REORDERED`).
4. An output was added, removed, or changed in script or value (`OUTPUT_SET_CHANGED`, `SCRIPT_CHANGED`, `VALUE_CHANGED`).
5. A protected asset moved somewhere other than its expected output, or moves at all when none were expected (`PROTECTED_ASSET_MISPLACED`).
6. A required user input is still unsigned (`REQUIRED_SIGNATURE_MISSING`).
7. A signature appeared with a sighash the manifest did not approve (`SIGHASH_UNEXPECTED`).
8. A signature covers an input the user does not control (`SIGNATURE_ON_FOREIGN_INPUT`).
9. An unknown critical field appeared (`UNKNOWN_CRITICAL_FIELDS`).

Any difference between what was presented and what came back is a refusal, never an adaptation. The signing stepper surfaces the exact field and the human explanation, and preserves the stable code in the technical details.

## The stepper

Build, verify, export or connect signer, sign offline, import, verify the signed result, refresh chain state, run node preflight, request the explicit broadcast, monitor settlement. Each step is resumable, the export carries the manifest digest, and the import step re-runs the full comparison before anything else happens.

## Watch-only profiles

A watch-only profile is a standard output descriptor or xpub, stored locally by default. Nothing uploads an xpub or a full address derivation set without an explicit privacy warning and an explicit opt-in. An optional synchronized profile is encrypted client side under a key the server never sees. Watch-only surfaces show holdings, build plans, and export PSBTs; signing controls render as unavailable, not hidden.

## Blind signing is prohibited

A signer is never asked to sign a transaction whose manifest was not shown and verifiable. Hardware wallets that display their own interpretation must agree with the manifest on network, recipients, and amounts; a disagreement is a blocked signing session, and the disagreement is displayed.
