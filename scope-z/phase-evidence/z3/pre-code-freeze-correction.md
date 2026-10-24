# Original freeze retained, pre-code correction

Original `frozen-public-cases.json`, SHA-256
`2a8385ed1b1a2ba4ef9ef5e28dcc960be9fb0cd71fde63f061987d37a13f1515`,
is retained unchanged. The independent exhaustive oracle found, before product
code, that F30's proposed positives could not preserve fair continuations:
the good absorbing state was in neither justice set. It also showed both
non-bottom SCCs intersected all justice sets, contradicting this structural
specification.

Correct only that generator's original justice sets, from `{1,3},{2,4}` to
`{1,6},{2,4,6}`. Now one non-bottom SCC is fair, the other is not, and the
good bottom component has fair continuations. These are new original input
bytes, not reuse of an old certificate, changed expected answers or a solver
fix. Freeze the corrected population separately as `frozen-public-cases-v2.json`
before implementation. The implementation-absent failure remains retained.
All other cases, denominators, limits and stopping rules are unchanged.
