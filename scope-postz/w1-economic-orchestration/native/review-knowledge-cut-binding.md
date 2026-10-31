# Explicit lawful knowledge cut

Before production repairs, extend the preceding review predicates to bind an
explicit `knowledgeAt` in each descriptive dataset/fitted state and conditional
fitted state. Native producers supply actual observation time; reconstruction
uses the retained cut, not the current clock or inferred maximum sample date.

Fit refuses any sample after that cut. A consumer at an earlier cut returns
UNKNOWN or requires native fallback, including future calibration. Appending
evidence must explicitly advance or preserve the original cut, never regress
it. The existing original-byte failure run remains intact. This strengthens
the future-observation predicate; it does not turn that failure into a pass.

Conditional fallback without a complete original native frame must refuse,
not return a partially populated DISPATCH. The owning conditional driver adds
that concrete predicate before the successful handoff type is strengthened.
