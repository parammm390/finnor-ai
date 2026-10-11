# Successor-6 campaign failure model (delta)

Inherits all five prior failure models. Addition from successor-5's retained
S5 failure:

1. **Runtime identity checks make file filters part of the behavioral
   contract.** `intervention-backend.ts` hashes four sources at module load —
   including `intervention-requirements.txt` — and re-verifies them on every
   invocation. A projection filter that copies only code extensions silently
   breaks that contract: every S3-backend case failed with
   `BACKEND_SOURCE_IDENTITY_UNAVAILABLE_OR_CHANGED` while the backend-free
   readback case passed. The filter now includes `.txt`; both requirement
   files are verified present in the scratch cut, and the supplied runtime
   matches the adapter's `PINNED` versions (numpy 2.3.3, scipy 1.16.2,
   statsmodels 0.14.5, arch 8.0.0, pandas 2.3.2).
2. **A systematic per-case failure is a signal about the harness, not the
   product.** 13/14 identical identity failures with clean infrastructure
   receipts pointed at the cut, not at S3/S5 semantics; the one
   backend-independent case passing confirmed the split.
3. Successor-5 remains sealed INCOMPLETE. Its receipts (23/23 owner PASS
   under the global clock, conformance PASS, 13 backend-identity S5 failures
   with one backend-free pass) are chained in
   `campaign-successor-6/registration.json`; successor-6 re-establishes all
   case sets under its own clock.
