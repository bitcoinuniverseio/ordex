# Collection provenance registry v1

Status: active at protocol 1.2. Artifacts: `ordex.collection-manifest/v1`, `ordex.collection-manifest-revocation/v1`. Reference verifier: `verifier/collection-manifest.js`. Vectors: `conformance/collection-manifest-vectors.json`.

The registry establishes cryptographic facts about who created a collection and who belongs to it. It does not turn moderation or curation into protocol truth. Claims stay separate: what the creator signed, what is anchored on chain, what the gateway curates, what third parties list, and what the community reports. No badge ever hides which claim was proven.

## The manifest

A manifest carries: network, protocol family (`ordinals`, `runes`, `stamps`, `counterparty`, `multi`), a stable collection id, display name and description, creator address, the member identity type (`inscriptionId`, `output`, `assetId`, `satpoint`), the member list, the membership Merkle root, metadata and trait schema hashes, media digests, a supply statement, an optional parent collection, an optional rights declaration, optional royalty metadata, creation height, version, the previous manifest digest when superseding, an optional on-chain anchor, the status, the creator BIP-322 signature, and the digest.

The rights field is a creator-signed declaration, displayed as such. It is never interpreted as a legal guarantee and never enforced by custody.

Rules the verifier enforces:

1. The member list is stored sorted with no duplicates (`MEMBERS_UNSORTED`, `MEMBERS_DUPLICATED`).
2. The membership root recomputes from the member list exactly (`MEMBERSHIP_ROOT_MISMATCH`).
3. A FIXED supply declares exactly the member count (`SUPPLY_MISMATCH`).
4. Version 2 and later name the manifest they supersede; version 1 cannot (`PREVIOUS_DIGEST_REQUIRED`, `PREVIOUS_DIGEST_FORBIDDEN`).
5. The signature address is the creator address (`SIGNER_IDENTITY_MISMATCH`). Proving the BIP-322 signature itself is the gateway's and SDK integrator's job, the same division as every other verifier here.
6. The digest recomputes over sorted-key JSON of everything except the signature and the digest (`DIGEST_MISMATCH`). Editing anything after signing, including one character of the display name, breaks the digest.

## Membership proofs

Leaves are `SHA-256(sorted-key JSON of { domain: "ordex.collection-member/v1", collectionId, memberIdentity })`. Interior nodes combine child digests in ascending byte order inside `{ domain: "ordex.collection-node/v1", left, right }`. Domain separation means a member leaf can never be replayed as an interior node or as any other artifact's leaf.

`buildMembershipProof` walks the sorted tree and returns the sibling path. `verifyMembershipProof` needs only the manifest, the member identity, and the proof: no network call, no gateway. A stranger's identity, a tampered sibling, and a member removed in a newer version all refuse with `MEMBER_NOT_PROVEN`.

## Publication, versioning, revocation

A manifest is drafted, validated locally, signed by the creator, and then published. Publication is immutable. Corrections are a new version whose digest names the previous one. Supersession and revocation are creator-signed documents; a revocation (`ordex.collection-manifest-revocation/v1`) binds the exact manifest digest, states a reason, and is refused when signed by any address other than the creator. History is never deleted: superseded and revoked versions remain visible with their statuses.

Optional anchoring writes the manifest digest into an inscription or transaction through the existing Universe infrastructure. Anchor state is separate from signature state: `ANCHOR_PENDING`, `ANCHORED`, `ANCHOR_CONFLICTED`, and `REORGED` never change the fact that the creator signed.

## Verification states

DRAFT, CREATOR_SIGNED, ANCHOR_PENDING, ANCHORED, SUPERSEDED, REVOKED, SIGNATURE_INVALID, MEMBERSHIP_INVALID, ANCHOR_CONFLICTED, REORGED.

## Compatibility

Existing 1.1 collection roots (the offers Merkle root) remain readable. A deterministic adapter maps a 1.1 root and its member leaves into a 1.1-shaped offer verification without claiming manifest-level properties the 1.1 root never carried.

## Gates

Every displayed proof badge must be reproducible by the SDK and the reference verifier. An invalid signature never displays as creator-signed. A missing member never passes a proof. A changed metadata digest changes the manifest digest. No central administrator can silently rewrite a creator-signed manifest: the gateway stores and serves documents, the signatures decide what is true.
