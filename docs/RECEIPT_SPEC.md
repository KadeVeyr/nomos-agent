# NOMOS Receipt — v1.0 (locked)

A **NOMOS receipt** is a small, portable JSON artifact that proves a task's answer
was checked by a **different provider's** model acting as an adversarial verifier.
It carries **no secrets** — only the task, the two models, their outputs/verdict,
and a content hash — so it is safe to commit to a repo or hand to a third party.

The point of this spec: the check is **keyless content-addressing**, not a
signature. Anyone can re-implement the algorithm below and re-check any v1.0
receipt **offline, forever, with zero provider calls**. `nomos receipt verify
<file>` is one implementation; this document is the contract it honors.

## What a receipt IS — and is NOT (read this first)

A receipt is a **tamper-evident, offline-re-checkable RECORD** of a cross-provider
verification. It is **not** a zero-trust cryptographic proof. Be precise about
what it gives you, or you will over-trust it.

**It gives you:**
- a stable content **id** anyone can recompute offline to confirm the receipt's
  fields are internally consistent and unaltered *since it was written*;
- a `cross_provider` flag **re-derived** from the two provider fields (so it can't
  be flipped to `true` without also changing the provider strings);
- a small, portable artifact you can commit, diff, and pin in CI.

**It does NOT give you (honest boundaries — state these to anyone you hand one to):**
- **Anti-forgery.** The hash is keyless: whoever *generates* a receipt can put any
  task/model/verdict/reasoning in it and recompute a matching hash. Trust in a
  receipt is trust in **whoever generated it** (e.g. your own CI). The hash defends
  against accidental/in-transit corruption and gives a stable id — it does **not**
  stop a motivated forger who controls the generator.
- **Proof of which model ran.** `verifier.model` is a *string*, not an attestation.
  A generator can claim a stronger verifier than actually executed.
- **Un-fakeable independence.** The re-derivation catches an *inconsistent* label
  (same provider, `cross_provider:true`). It does **not** catch a *consistent*
  forgery — two different but invented provider strings with a recomputed hash.
- **Proof the check was thorough.** A lazy or colluding verifier can rubber-stamp
  `PASS` with vacuous or even contradictory reasoning; nothing here detects that.

Used as intended — a pinnable, re-checkable record produced by a generator you
trust — no other agent emits this as a native primitive. Closing the zero-trust
gap (provider signatures / attestation) is future work, not a v1.0 claim.

## Shape

```json
{
  "nomos_receipt": "1.0",
  "id": "9f2a1c4b7e0d",
  "created": "2026-06-14T01:22:05.000Z",
  "task": "Refactor parseConfig to reject unknown keys",
  "proposer": { "model": "anthropic/claude-opus-4-8", "provider": "anthropic", "output": "...", "steps": 7 },
  "verifier": { "model": "openai/gpt-5.5", "provider": "openai", "verdict": "PASS", "reasoning": "..." },
  "cross_provider": true,
  "verdict": "PASS",
  "hash": "9f2a1c4b7e0d…(64 hex)"
}
```

`created`, `id`, `steps`, and the top-level `verdict` are **derived/convenience**
fields — they are NOT part of the hashed pre-image. They are instead checked for
*consistency* against the signed source during verification (so flipping a
convenience copy is caught).

## The canonical pre-image

The hash is `sha256` over the UTF-8 bytes of this exact JSON, keys in this exact
order, no insignificant whitespace (a plain `JSON.stringify` of this object):

```js
JSON.stringify({
  v: receipt.nomos_receipt,
  task: receipt.task ?? null,
  proposer_model: receipt.proposer?.model ?? null,
  proposer_provider: receipt.proposer?.provider ?? null,
  proposer_output: receipt.proposer?.output ?? null,
  verifier_model: receipt.verifier?.model ?? null,
  verifier_provider: receipt.verifier?.provider ?? null,
  verifier_verdict: receipt.verifier?.verdict ?? null,
  verifier_reasoning: receipt.verifier?.reasoning ?? null,
  cross_provider: receipt.cross_provider ?? null,
})
```

- `hash = sha256(canonical_preimage)` as lowercase hex.
- `id = hash.slice(0, 12)` (first 12 hex chars).
- `cross_provider = (proposer.provider !== verifier.provider)`.

**Determinism rules** (so an independent implementation computes the *same* hash):
- Hash the **raw UTF-8 bytes** of the strings as given — apply **no** Unicode
  normalization (NFC/NFD). Two receipts whose text differs only by normalization
  are different receipts.
- Types are fixed: `v`/`task`/the model/provider/output/verdict/reasoning fields are
  **strings or `null`**; `cross_provider` is a **boolean or `null`**. Do not coerce
  (`1` is not `true`, `0` is not `"0"`). A non-conforming type yields a different
  pre-image and therefore a different hash.
- Absent and `undefined` fields canonicalize to `null` (the `?? null`).
- `makeReceipt` writes `verifier.verdict = "UNKNOWN"` when the verifier returned no
  verdict; that hashes literally as `"UNKNOWN"` and then fails the completeness
  check (step 6) — an incomplete input yields an incomplete (invalid) receipt.

## Verification algorithm (offline, no network)

A receipt is **valid** iff it is BOTH *intact* AND *complete*.

**Intact** (tamper + faked-independence):
1. Recompute `sha256(canonical_preimage)`; it must equal `receipt.hash`.
2. `receipt.verdict === receipt.verifier.verdict` (no swapped display verdict).
3. `receipt.id === receipt.hash.slice(0, 12)`.
4. `receipt.cross_provider === (receipt.proposer.provider !== receipt.verifier.provider)`
   — re-derived, so a "same-provider run relabeled cross_provider:true" fails even
   if the hash was recomputed to match the forged content.

**Complete** (not truncated/malformed):
5. `proposer.model`, `proposer.provider`, `verifier.model`, `verifier.provider` present.
6. `verifier.verdict ∈ { PASS, FAIL, CONCERNS }` — any other value (or empty) means
   the verifier reply was cut off before a verdict and must NOT read as success.
7. `verifier.reasoning` non-empty.
8. `task` non-empty.

`nomos receipt verify <file>` exits **2** if a receipt is not valid (so it gates
CI), prints `✓ intact` / `✗ TAMPERED` / `✗ INCOMPLETE`, and with `--json` emits
`{ id, ok, intact, issues, cross_provider, verdict }`.

## What verification catches — and what it can't

| Case | Caught by | Notes |
|---|---|---|
| **Post-hoc edit / corruption** — a receipt altered (or corrupted in transit) *without* recomputing the hash | step 1 (hash mismatch) | This is the tamper-EVIDENCE the id buys you against anyone who is not the generator. |
| **Inconsistent forgery** — flip the display verdict/id but not the signed source; or set `cross_provider:true` with the *same* provider | steps 2–4 | The consistency + re-derivation checks. |
| **Truncated/empty verdict** — a cut-off verifier reply presented as a pass | steps 6–7 (completeness) | A verdict outside {PASS,FAIL,CONCERNS}, or empty reasoning, fails. |
| **Generator forgery** — whoever runs `makeReceipt` fabricates any field and recomputes a matching hash | **NOT caught** | Keyless = no authorship binding. Trust the generator. |
| **Invented providers** — two different but fake provider strings, hash recomputed | **NOT caught** | Re-derivation only catches *inconsistent* labels. |
| **Rubber-stamp verifier** — a verifier that always returns PASS with vacuous/contradictory reasoning | **NOT caught** | No mechanism judges verification quality. |

The first three rows are the guarantees. The last three are the honest limits of a
keyless receipt — closing them needs provider signatures/attestation (future work).

## Stability

v1.0 is **locked**: the pre-image field set, order, hashing, id derivation, and
the cross_provider rule will not change under the `1.0` version tag. A future
breaking change ships under a new `nomos_receipt` version; v1.0 receipts keep
verifying against this document.
