# Changed-scope review

The review compared the proposed Y3 files with local integration commit
`6b7f3748009358ad4849d4cc743e9da336fe08bc`. It did not re-review or modify the
pinned Y1/X implementations except at the explicit Y3 integration points.
Three independent read-only scopes covered mathematics, canonical owners and
mounted/packaging integration. The main thread validated candidates against
actual callers before repairing them.

| Finding | Resolution | Verification remaining |
| --- | --- | --- |
| A fact source could advance between the native history check and effect commit because only its immutable version was locked | `sourceClaimTx` first locks the stable S1 source row, then reads its head in a new READ COMMITTED statement; the transaction retains the lock through the effect | `E-observation-source-head-locks-through-native-commit-and-retains-corrected-readback` |
| A fifth prequeued request could stay QUEUED after the original four-attempt allocation was exhausted | The native owner publishes INCOMPLETE with an append-only refusal event, no new attempt/search allocation and no retry loop | `G-prequeued-requests-share-exhausted-original-allocation-with-terminal-readback` |
| Focus could advance the UI epoch without releasing the old mutation's busy latch | Focus/online recovery clears the local busy latch before refreshing; uncertain original requests remain bounded and replayable | Held-submit focus case in `browser-checks.mts` |
| A corrected observation caused run readback to throw before showing retained S7 responsibility | History-currentness failures now return an invalidated local projection while retaining the original owner-only native programme readback | Included in the source-head race case |
| The inherited fixture used `persistent:false`, which deletes its scratch database during `close()` | The shared fixture now has an opt-in `keepDatabase` flag, unchanged default behavior for existing callers, and a checked retention receipt. Y3 always opts in | Actual retained database shutdown remains unrun under the storage stop |

The mathematical scope returned no findings. The fixes above have code-level
review and permitted static validation only. Their E2E/browser regressions were
not run after the user stopped disk-heavy verification. An additional independent
read-only pass covered the complete new build-custody, packaging, reconstruction,
sealing and harness helpers. Its database-retention finding was validated against
the actual fixture and dependency contract, then repaired. These helpers have
permitted syntax/type evidence, not an independent clean-reconstruction run.

The old `source-owner-5` scratch database was observed absent. Its earlier
disposable fixture ran before the keep-databases decision. Its STOPPED receipt
must not be presented as evidence that raw database bytes were retained. No new
database campaign or cleanup ran after that decision. The new retention option
does not recreate an already removed historical database.

Earlier retained failures also corrected fixture-only mistakes: rebasing the
goal's original quantity basis; expecting the canonical S5 capacity conflict
409/code instead of 422; distinguishing a programme's S7 observation from
completion of the containing Work; and using the canonical suspended-user
status. Exact mathematical, consent and authority guards were not weakened.
