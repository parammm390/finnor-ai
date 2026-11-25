---------------------------- MODULE WorkRecovery ----------------------------
(* POST /api/works/:id/retry for one failed Work, as the code runs it:
   the route's unlocked owner read, claimWorkRecovery, the "understanding"
   transition in handleInstructionResult, beginWorkPlannerAttemptTx and the
   planner's end. Each step below is one transaction or one unlocked read in
   finnor-os/packages/db/index.ts or apps/api/app/api/works/[id]/retry/route.ts.
   Variant selects which version of that code runs. *)
EXTENDS FiniteSets, Naturals

CONSTANTS Variant, MaxHandoffs

ASSUME Variant \in {"current", "before_planner_fence", "pre_082260a2", "pre_17034c60", "unlocked_owner_check"}

Requests == {"r1", "r2", "r3"}
Employees == {"e1", "e2"}
Requester == [r \in Requests |-> IF r = "r3" THEN "e2" ELSE "e1"]

VARIABLES status, owner, lease, attempts, pc, claims, handoffs
vars == <<status, owner, lease, attempts, pc, claims, handoffs>>

Statuses == {"failed", "recovery", "understanding", "planning", "completed"}
Stages == {"start", "prechecked", "read", "claimed", "understood", "planning", "done"}

TypeOK ==
  /\ status \in Statuses
  /\ owner \in Employees
  /\ lease \in [key : Requests \cup {"none"}, live : BOOLEAN]
  /\ attempts \subseteq Requests
  /\ pc \in [Requests -> Stages]
  /\ claims \subseteq Requests \X Employees
  /\ handoffs \in 0..MaxHandoffs

Init ==
  /\ status = "failed"
  /\ owner = "e1"
  /\ lease = [key |-> "none", live |-> FALSE]
  /\ attempts = {}
  /\ pc = [r \in Requests |-> "start"]
  /\ claims = {}
  /\ handoffs = 0

Stop(r) == pc' = [pc EXCEPT ![r] = "done"]

(* The route reads workAggregate without a lock and answers 404 to anyone but
   the current owner. Before 17034c60 the route had no owner check at all. *)
Precheck(r) ==
  /\ pc[r] = "start"
  /\ IF Variant \in {"pre_082260a2", "pre_17034c60"} \/ owner = Requester[r]
       THEN pc' = [pc EXCEPT ![r] = "prechecked"]
       ELSE Stop(r)
  /\ UNCHANGED <<status, owner, lease, attempts, claims, handoffs>>

Claimable(r) ==
  /\ r \notin attempts
  /\ status \in {"failed", "recovery"}
  /\ ~(status = "recovery" /\ lease.live)

(* claimWorkRecovery holds SELECT ... FOR NO KEY UPDATE on the Work row for
   the whole transaction, so the owner recheck and the lease write are one step. *)
Claim(r) ==
  /\ Variant # "pre_082260a2"
  /\ pc[r] = "prechecked"
  /\ IF /\ Variant \in {"current", "before_planner_fence"} => owner = Requester[r]
        /\ Claimable(r)
       THEN /\ status' = "recovery"
            /\ lease' = [key |-> r, live |-> TRUE]
            /\ claims' = claims \cup {<<r, owner>>}
            /\ pc' = [pc EXCEPT ![r] = "claimed"]
       ELSE Stop(r) /\ UNCHANGED <<status, lease, claims>>
  /\ UNCHANGED <<owner, attempts, handoffs>>

(* Before 082260a2 the route read the Work status, then wrote "recovery"
   through transitionWork in a second call. *)
ReadStatus(r) ==
  /\ Variant = "pre_082260a2"
  /\ pc[r] = "prechecked"
  /\ IF r \notin attempts /\ status \in {"failed", "recovery"}
       THEN pc' = [pc EXCEPT ![r] = "read"]
       ELSE Stop(r)
  /\ UNCHANGED <<status, owner, lease, attempts, claims, handoffs>>

WriteRecovery(r) ==
  /\ pc[r] = "read"
  /\ status' = "recovery"
  /\ claims' = claims \cup {<<r, owner>>}
  /\ pc' = [pc EXCEPT ![r] = "claimed"]
  /\ UNCHANGED <<owner, lease, attempts, handoffs>>

(* transitionWork(..., "understanding") checks only the latest Work input. *)
Understand(r) ==
  /\ pc[r] = "claimed"
  /\ IF status \in {"recovery", "understanding", "planning"}
       THEN status' = "understanding" /\ pc' = [pc EXCEPT ![r] = "understood"]
       ELSE Stop(r) /\ UNCHANGED status
  /\ UNCHANGED <<owner, lease, attempts, claims, handoffs>>

(* beginWorkPlannerAttemptTx holds the Work row lock. The current code also
   refuses a retry attempt whose key no longer holds the recovery lease. *)
BeginPlanner(r) ==
  /\ pc[r] = "understood"
  /\ IF r \notin attempts /\ (Variant = "current" => lease.key = r)
       THEN /\ attempts' = attempts \cup {r}
            /\ status' = "planning"
            /\ pc' = [pc EXCEPT ![r] = "planning"]
       ELSE Stop(r) /\ UNCHANGED <<attempts, status>>
  /\ UNCHANGED <<owner, lease, claims, handoffs>>

Finish(r) ==
  /\ pc[r] = "planning"
  /\ \E outcome \in {"completed", "failed"} : status' = outcome
  /\ Stop(r)
  /\ UNCHANGED <<owner, lease, attempts, claims, handoffs>>

(* handoffWork gives the Work to another active employee at any moment. *)
Handoff ==
  /\ handoffs < MaxHandoffs
  /\ \E e \in Employees \ {owner} : owner' = e
  /\ handoffs' = handoffs + 1
  /\ UNCHANGED <<status, lease, attempts, pc, claims>>

(* WORK_RECOVERY_CLAIM_TTL_MS passes while the claiming request is still busy,
   for example in assembleOperatingContext. *)
LeaseExpires ==
  /\ lease.live
  /\ lease' = [lease EXCEPT !.live = FALSE]
  /\ UNCHANGED <<status, owner, attempts, pc, claims, handoffs>>

Next ==
  \/ Handoff
  \/ LeaseExpires
  \/ \E r \in Requests :
       \/ Precheck(r) \/ Claim(r) \/ ReadStatus(r) \/ WriteRecovery(r)
       \/ Understand(r) \/ BeginPlanner(r) \/ Finish(r)

Spec == Init /\ [][Next]_vars

(* Two planners on one Work plan the same instruction twice and can propose
   or execute the same business actions twice. *)
SinglePlanner == Cardinality({r \in Requests : pc[r] = "planning"}) <= 1

(* A recovery starts only for the employee who owns the Work when it starts. *)
OwnerOnly == \A claim \in claims : claim[2] = Requester[claim[1]]
=============================================================================
