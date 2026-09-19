# Ordinals Mainnet implementation preparation

Repository: ordex
Baseline: d7d1378cecdc833a96b9a2b542acf0dc4463934b
Prepared branch: prep/ordinals-20260919
Prepared worktree: D:/universe/ordex/.worktrees/ordinals-prep-20260919

Full handoff directory on SERVER: D:/universe/core/audits/implementation-prep-20260919-ordinals

Read README.md, IMPLEMENTATION-PROMPT.md, ANNOTATION-INDEX.md, WORK-PACKAGES.md and RESEARCH.md in that directory. Source annotations are applied, not implemented functionality. Do not push/merge/deploy these comments as a functional fix. Real Signet (or justified Testnet) acceptance and public Mainnet release remain required.

- A023 ORD-11: verifier/purchase.js :: export function verifyPublicAskCompletion(transaction, order) {
- A024 ORD-11: sdk/src/purchase.ts :: export function verifyPublicAskCompletion(

Preserve concurrent work. The full patch including this instruction file is bundled. Temporary comments can be removed only after the corresponding work package is implemented and verified.
