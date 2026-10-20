# Original quantity text types — pre-repair oracle

The registered repaired-kernel001 passes kernel/protocol/reconstruction/replay-timing but checker-review fails the original frozen numericCurrencyAndUnit expectation: COVERAGE instead of QUANTITY. Do not edit native-expectations.json. The exact numeric lexeme reader currently converts every JSON numeric scalar to a decimal string, including currency and unit. Therefore an original numeric unit can become an apparently valid textual unit; literal string units and numeric unit values are distinct source types.

Independent component oracle before repair uses the original retained source/candidate, without invoking producer inference. Change only original/candidate unit to numeric 1: reject at QUANTITY. Change only currency to numeric123: reject at QUANTITY. The literal supported unit "units" remains ACCEPTED. The literal string "1" remains unsupported under the existing alphabetic unit grammar: with no unresolved disclosure, it reaches COVERAGE. Repeat numeric-unit challenge through native financial-ledger fields amount/account/accountingBasis and an independently identical quantity candidate: reject at QUANTITY. Preserve IDs, mappings, chronology, contradiction and obligation populations. Original 128-character exact decimal/identity token support remains unchanged; existing original amount12.0000000000000001 must never round to12.

Pre-repair001 is retained as FAIL. Its proposed ACCEPTED expectation for the literal text "1" was an oracle mistake: the existing quantityContext grammar explicitly requires an alphabetic first unit character. No product change had been written. Pre-repair002 corrects that control to the actual supported "units" and separately preserves the unsupported text result. The observed defect is loss of nominal scalar type and the wrong rejection boundary; this run has not demonstrated accepted unauthorized execution.

Failure model: normalize a numeric unit/currency/context into text; reject through unrelated coverage; accept underflow as a nominal label; break supported numeric amounts or identities; reject legitimate literal string labels; import producer semantics into the independent reader; infer currency/unit; loosen currentness or bounds. Preserve source scalar types for nominal quantity context. A typed raw quantity-context refusal may reach QUANTITY through the checker; other malformed/unsupported raw inputs still reach their own coverage/chronology/bound checks. Expectations remain original and independent. This isolated checker probe is not authenticated owner completion or protected qualification.

Supported identifier correction before further product edit: the original f7fa088
native reader explicitly normalizes safe numeric account identifiers through its
native string helper. An account identifier differs from a currency/unit label.
The nominal-field set added by 1bf61cc also includes account and description;
that over-restricts the preexisting native account/fallback-identifier domain.
Add independently fixed native controls: account123 or fallback description123
maps to the literal factKey "123", preserving all other original quantities,
contradictions, identities and obligations. Both must remain ACCEPTED. They must
fail on the over-restricted current reader before repair. Preserve the original
five cases, 128-character exact decimal/identity support and all numeric
currency/unit refusals; remove only the inappropriate identifier-label treatment.
