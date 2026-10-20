# Original Work compute history — pre-code reader contract

Read existing immutable S7 COMPUTE records through the economic owner. Bind the
authenticated principal/Work and its original compiler/native episode IDs.
Do not create a cost store or derive financial value from native compute.

Credible failures for the authenticated Work/cost readback scenario:

1. A coordinator, compiler or continuation fails or is reclaimed. Keep every
   physical delivery's registered compute receipt in the same Work history.
2. Cross-principal/tenant/Work/episode rows and altered owner-record preimages
   cannot appear in the projection. Read full records through S7 decoding.
3. Duplicate delivery/phase or malformed elapsed measurements create a visible
   gap. They do not double-count a physical measurement or silently become zero.
4. Bound overflow returns an explicit incomplete projection, not complete costs.
5. Observed elapsed work is a sum of attributed delivery durations; sampled
   process RSS is not aggregate simultaneous peak. Unknown price, human time,
   network/storage, setup and validator costs remain unknown.

Rerun evidence binds S7 record IDs/digests, original episodes/reservation and
actual job/delivery IDs, including retained failures. Live readback: NOT RUN.

The finite source review identified empty/unregistered physical delivery/phase
values receiving elapsed credit. Require actual UUID identities and the registered
COMPILE/UPDATE_RECOGNITION/PREPARATION/RECOVERY phase vocabulary before credit.
Native preparation also retains its physical S7 receipt and uses its unique
original P1 step as the S5 delivery ordinal. Its step cap and every X1 claim
publication must check the original bound and unexpired actual queue lease.
