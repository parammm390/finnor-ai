# R8 bounded grammar, frozen before search

Version `r8-bounded-integer-ast-v1`; exact unbounded integer meaning with operational bounds.

Expressions: integer literals [-21,21], six named input references, initialized local references, add/subtract/multiply, exact lt/lte/eq/gte/gt comparisons, Boolean literals/and/or/not, conditionals, and three-project membership (`mask` integer, fixed bit position 0…2).
Statements: local assignment, conditional with two finite statement lists, and statically bounded integer `for` loops with literal initialization/end/update. End is exclusive. The output references an initialized integer local.
No other field/operator is admitted. No recursion, eval, import, host call, I/O, ambient globals, persistent state, nondeterminism or dynamic loop bound.

Limits: 512 AST nodes, depth 24, 32 local names, 16 KiB canonical AST, 7 loop iterations per loop, 1 loop, 1,024 executed statement/expression steps with memo-free operational accounting, absolute intermediate integer at most 63.
The independently checked lowered SSA has at most 256 registers, 16 outputs (R8 uses one), and 65,536 compiled bytes. Exceeding an inherited limit refuses, never changes arithmetic.
Fuel exhaustion is failure, not termination. All integer branches are lazy; assignments observe statement order. Membership is independently checked and constant-folded only after loop unrolling.

## Supplied skeleton and genuine holes

The producer supplies a bounded optional-subset scan skeleton: initialize mask/value to zero; traverse masks 1…7; conditionally improve the incumbent; return mask.
Rosette chooses:

- seven subset-enabled Boolean holes;
- cost input family (costs or utilities);
- supplied-utility versus utility-minus-cost score;
- capacity literal 6, 7 or 8;
- strict versus inclusive feasibility;
- strict versus inclusive incumbent improvement;
- ascending versus descending traversal.

These choices include deficient procedures and exact complete enumeration. They are not a 262,144-answer table.
The search minimizes the number of enabled masks by solving cardinality caps zero through seven under retained examples. It may keep the first exact accepted candidate; no globally cheapest-code claim follows.
Initial visible examples include zero/tie, each singleton and capacity boundary examples, but do not constrain every combination. A real incomplete-subset candidate must reach the independent verifier and be archived before repair.

Rosette sees only this trusted encoding and JSON examples. It never evaluates candidate-supplied Racket or JavaScript.
Each query clears verification conditions, sets `current-bitwidth #f`, uses the explicitly pinned Z3 executable, and terminates its solver.
Every proposal is parsed into this same grammar. Independent Python semantics do not import the builder, Rosette query, lowering or producer selection.
