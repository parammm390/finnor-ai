/**
 * Z3 native session (Level 2). DESIGN ONLY: this file documents the function
 * boundary a full Z3 -> S4 -> X2 -> S5/S6 -> Z3 native scenario needs and
 * refuses to run, so it can never be mistaken for evidence.
 *
 * Ready (Z3 worker, branch w/z3-s4):
 *   - requestInstitutionApplicationExecution(ctx, input): governed origin child of
 *     the accepted institution-origin parent (application-semantics/api.ts).
 *   - selectGeneralExecutableOperationTx / executableSelectionStateTx: the Z3 writer
 *     and the retained-receipt reader (z3-viability/general-owners.ts), driven by
 *     consumeGeneralViabilityTx for models whose APPLICATION_COMPOSE edge targets a
 *     governed child.
 *   - X2 consumer: governed.ts + worker.ts runGovernedChild, SQL branch of
 *     z0_s5_application_consumption in postz_zi_z3_s4_executable_selection.sql.
 *   - Scenario s4-governed-child-session.mjs (application-owner half).
 *
 * Waiting on (not provided by any current fixture):
 *   B3. The original Work input is fixed before the acquisition (Z0 A5 refuses an
 *       appended input) but the Z3 native map must name the application model
 *       revision (APPLICATION_SNAPSHOT observer revision == model.ref, which embeds
 *       knowledge_cut and Work refs). A map that exists before the model cannot
 *       name it. Needed from the S4/Z3 owner: an observer that binds the accepted
 *       institution-origin model by its acceptance (responsibility identity +
 *       S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED) instead of a pre-known ref, or an
 *       admitted map revision that re-binds the same original Work input.
 *   B4. S8 consumer installation (native-s8-fixture.mts) in the z0 stack so the
 *       governed child's wire step can be delivered to the disposable portal.
 *
 * Boundary a runnable version will call, in order, all on one z0 --no-worker stack:
 *   1. createOriginalInstitutionParent(env, { instruction })       [x1-origin-fixture.mts]
 *        -> must accept the Z3 map as the Work instruction (needs B3).
 *   2. driveAcquisitionToModelReady(env, parent, options)           [x1-origin-fixture.mts]
 *   3. releaseHeldOut + profile swap + requestInstitutionApplicationExecution
 *        (copy from s4-governed-child-session.mjs case G04).
 *   4. createViabilitySession(ctx, { workId, ... }) then the Z3 worker job
 *        (z3-viability/worker.ts) until the checked strategy is VIABLE and the
 *        first prefix selects an executable step.
 *   5. owned X2 worker consumes the selection; requestViabilityRecovery(ctx, ...)
 *        continues Z3 at the E-state from the retained receipt.
 *   6. SIGKILL of the owned workers at the five boundaries of the failure model.
 */
throw Error("Z3_SESSION_DESIGN_ONLY_NOT_RUN: blocked by B3 (map/model circularity) and B4 (S8 consumer in the z0 stack)");
