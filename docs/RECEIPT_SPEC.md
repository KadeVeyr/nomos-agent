# NOMOS Receipt — v1.0 (locked)

A **NOMOS receipt** is a small, portable JSON artifact that proves a task's answer
was checked by a **different provider's** model acting as an adversarial verifier.
It carries **no secrets** — only the task, the two models, their outputs/verdict,
and a content hash — so it is safe to commit to a repo or hand to a third party.

The point of this spec: the check is **keyless content-addressing**, not a
signature. Anyone can re-implement the algorithm below and verify any v1.0 receipt
**offline, forever, with zero provider calls**. `nomos receipt verify <file>` is
one implementation; this document is the contract it honors.

> Keyless means the hash proves a receipt *matches its own id/content* — it does
> not prove *who* authored it. Independence (cross-provider) is **re-derived** from
> the two provider fields, so it cannot be forged by flipping a boolean.

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

## The three failure modes it catches

| Attack | Caught by |
|---|---|
| **Tamper** — edit the task, output, model, or verdict after the fact | step 1 (hash mismatch) |
| **Faked independence** — relabel a same-provider check as cross-provider | step 4 (re-derivation) |
| **Truncated verdict** — a cut-off verifier reply presented as a pass | steps 6–7 (completeness) |

## Stability

v1.0 is **locked**: the pre-image field set, order, hashing, id derivation, and
the cross_provider rule will not change under the `1.0` version tag. A future
breaking change ships under a new `nomos_receipt` version; v1.0 receipts keep
verifying against this document.
