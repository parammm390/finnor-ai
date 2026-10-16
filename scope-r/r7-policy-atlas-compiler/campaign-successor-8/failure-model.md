# Successor-8 campaign failure model (delta)

Inherits all seven prior failure models. Addition from successor-7's
post-completion supervision exception:

1. **Every supervisor filesystem interaction must tolerate mid-scan deletion.**
   The witness scan used `pathlib.rglob` directly over the phase tmp while the
   driver's `embedded-postgres` (`persistent:false`) was wiping its datadir
   during post-exit observation; the scan raised `FileNotFoundError` on
   `base/4` and the phase sealed INCOMPLETE after all 23 owner cases had
   already passed. Guarding individual file reads is not enough — directory
   enumeration itself races. The scan is now exception-contained.
2. **A supervision exception is never a PASS.** Even with 23/23 case results
   green, zero residual processes, and quotas inside limits, the phase
   correctly sealed INCOMPLETE: the supervisor's own integrity is part of the
   claim. Successor-7's owner results are chained as evidence, not carried as
   qualification.
3. Successor-8 re-establishes all case sets under its own clock with the
   hardened supervisor.
