# Cold signing and watch-only mode v2

Status: active at protocol 1.2. Artifacts: `ordex.expected-transaction-manifest/v2`, `ordex.offline-signing-session/v2`. Reference verifier: `verifier/offline-signing.js`. Vectors: `conformance/offline-signing-vectors.json`.

Cold signing is a signing mode, not a product silo: every transaction surface in Ordex, buys, listings, withdrawals, replacements, batch purchases, SafeOps, swaps, and heritage, can be completed through a connected wallet, a hardware wallet through its existing provider API, a PSBT file, base64 copy and paste, animated QR (crypto-psbt UR), or a static QR when the payload fits safely. Watch-only profiles can browse, plan, and export, and never imply they can sign.

## The SignerAdapter contract

One adapter interface with capability detection covers: connected-wallet signing (existing adapters), PSBT binary export and import, base64 copy and paste, animated QR through an established interoperable UR encoding, static QR fallback, hardware signing through audited wallet-provider APIs, and watch-only with no signing capability. No raw device key management exists anywhere in this codebase: keys and recovery material never pass through gateway, browser storage, or SDK.

PSBT v0 and v2 are supported where wallets require them. Conversion preserves the unsigned transaction, UTXO data, scripts, sighash policy, derivation metadata, and proprietary asset-protection fields, and refuses lossy conversions.

<!-- OX-P03: v2 commits to the exact unsigned transaction and the protection
policy, and judges a signed result from its bytes with real signature checks.
A v1 manifest or session is refused and presented again, never reinterpreted. -->

## The expected transaction manifest

Before any signing request, the flow builds a manifest: the network, one line stating the purpose, whether a watch-only profile prepared it, the transaction version and locktime, every input with its outpoint, sequence, exact value and script, whether the user controls it, the one sighash the user may sign it with, and one line on why it is spent, every output with its exact script, value, role, the assets expected there with their exact quantities, and one line on who receives it, the fee and its permitted maximum, and the digest.

An input the user does not control may record the signature it already carries, such as a seller's `SINGLE|ANYONECANPAY` signature on a public ask (`preservedSignature`). That signature must come back unchanged.

The digest is SHA-256 over the sorted-key JSON of the schema, the network, the exact unsigned transaction bytes (version, locktime, every sequence, and the input and output order), the prevout value and script of every input, and the protection policy: which inputs the user signs and with which sighash, which foreign signatures are preserved, every expected asset with its quantity and output, the fee and its maximum. The purpose, the explanations, the roles, the watch-only flag and the account are display text and sit outside it. Changing any security decision changes the digest.

`DEFAULT` names the Taproot default sighash; on a segwit v0 or legacy input it means `ALL`.

## The refusals

After a signed PSBT (v0 or v2, base64 or hex) or a signed raw transaction comes back, from any signer, it is parsed from its bytes and compared against the manifest. A caller's statement that an input is signed proves nothing. The comparison refuses with a stable code when:

1. The signed result was not produced from this manifest (`MANIFEST_DIGEST_MISMATCH`), the bytes do not parse (`MALFORMED_SIGNED_RESULT`), or a v2 PSBT's inputs require both a time and a height locktime (`LOCKTIME_UNDETERMINED`).
2. The fee left its approved bound (`FEE_OUT_OF_BOUNDS`).
3. The version or locktime changed (`TRANSACTION_CHANGED`), an input was added, removed, reordered or given another sequence (`INPUT_SET_CHANGED`, `INPUT_REORDERED`, `SEQUENCE_CHANGED`), or a PSBT names another spent output than the manifest (`PREVOUT_MISMATCH`).
4. An output was added, removed, or changed in script or value (`OUTPUT_SET_CHANGED`, `SCRIPT_CHANGED`, `VALUE_CHANGED`).
5. A required user input is unsigned (`REQUIRED_SIGNATURE_MISSING`), its signature does not verify under the BIP143 or BIP341 signature hash of the presented transaction (`SIGNATURE_INVALID`), or it spends a script the verifier cannot check (`SIGNATURE_UNVERIFIABLE`).
6. A signature uses a sighash the manifest did not approve (`SIGHASH_UNEXPECTED`).
7. An input the user does not control gained a signature (`SIGNATURE_ON_FOREIGN_INPUT`), or its preserved signature changed or no longer verifies (`FOREIGN_SIGNATURE_CHANGED`, `FOREIGN_SIGNATURE_INVALID`).
8. Protected assets were expected and the result carries no independent observation of where they landed (`PROTECTED_ASSET_OBSERVATION_MISSING`), or the observed movements differ from the expected ones in identity, quantity or output, in either direction (`PROTECTED_ASSET_MISPLACED`).
9. An unknown critical field appeared (`UNKNOWN_CRITICAL_FIELDS`).

A PSBT whose user signatures are partial is accepted as not yet complete; a raw transaction or a finalized PSBT with every input signed is complete.

Any difference between what was presented and what came back is a refusal, never an adaptation. The signing stepper surfaces the exact field and the human explanation, and preserves the stable code in the technical details.

## The stepper

Build, verify, export or connect signer, sign offline, import, verify the signed result, refresh chain state, run node preflight, request the explicit broadcast, monitor settlement. Each step is resumable, the export carries the manifest digest, and the import step re-runs the full comparison before anything else happens.

## Watch-only profiles

A watch-only profile is a standard output descriptor or xpub, stored locally by default. Nothing uploads an xpub or a full address derivation set without an explicit privacy warning and an explicit opt-in. An optional synchronized profile is encrypted client side under a key the server never sees. Watch-only surfaces show holdings, build plans, and export PSBTs; signing controls render as unavailable, not hidden.

## Blind signing is prohibited

A signer is never asked to sign a transaction whose manifest was not shown and verifiable. Hardware wallets that display their own interpretation must agree with the manifest on network, recipients, and amounts; a disagreement is a blocked signing session, and the disagreement is displayed.
