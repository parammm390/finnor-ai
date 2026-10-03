-- Recovery may read an existing protected commitment after the append budget.
-- It cannot reset append accounting or manufacture a trusted ordinary receipt.
ALTER TABLE finnor_os.s6_owner_delivery_states
 ADD COLUMN delivery_mode text NOT NULL DEFAULT 'APPEND'
  CHECK(delivery_mode IN ('APPEND','RECOVERY_READ')),
 ADD COLUMN recovery_checks integer NOT NULL DEFAULT 0
  CHECK(recovery_checks BETWEEN 0 AND 64);

CREATE OR REPLACE FUNCTION finnor_os.s6_owner_delivery_state_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=finnor_os,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'S6 delivery responsibility cannot disappear'; END IF;
 IF (NEW.tenant_id,NEW.principal_id,NEW.semantic_owner,NEW.kind,NEW.identity)
  IS DISTINCT FROM (OLD.tenant_id,OLD.principal_id,OLD.semantic_owner,OLD.kind,OLD.identity)
 THEN RAISE EXCEPTION 'S6 delivery identity is immutable'; END IF;
 IF OLD.status='ACCEPTED' AND NEW IS DISTINCT FROM OLD
 THEN RAISE EXCEPTION 'S6 accepted delivery receipt is immutable'; END IF;
 IF NEW.status='CLAIMED' THEN
  IF OLD.status NOT IN ('PENDING','RETRY','CLAIMED')
    OR NEW.lease_token IS NULL OR NEW.lease_until IS NULL
    OR NEW.lease_until<=clock_timestamp()
    OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
    OR OLD.status='CLAIMED' AND OLD.lease_until>clock_timestamp()
  THEN RAISE EXCEPTION 'S6 current delivery owner cannot be displaced'; END IF;
  IF NEW.delivery_mode='APPEND' THEN
   IF OLD.delivery_mode<>'APPEND' OR NEW.attempts<>OLD.attempts+1
     OR NEW.recovery_checks<>OLD.recovery_checks
   THEN RAISE EXCEPTION 'S6 append accounting cannot reset'; END IF;
  ELSE
   IF NEW.attempts<>64 OR NEW.attempts<>OLD.attempts
     OR NEW.recovery_checks<>OLD.recovery_checks+1
   THEN RAISE EXCEPTION 'S6 read recovery must conserve the append budget'; END IF;
  END IF;
 ELSE
  IF (NEW.attempts,NEW.recovery_checks,NEW.delivery_mode)
    IS DISTINCT FROM (OLD.attempts,OLD.recovery_checks,OLD.delivery_mode)
  THEN RAISE EXCEPTION 'S6 delivery accounting requires a new claim'; END IF;
  -- An exhausted expired read lease retains responsibility without another call.
  IF OLD.status='CLAIMED' AND OLD.delivery_mode='RECOVERY_READ'
    AND OLD.recovery_checks=64 AND OLD.lease_until<=clock_timestamp()
    AND NEW.status='REQUIRES_OPERATOR'
    AND NEW.last_error='OWNER_TRANSPORT_RECOVERY_BUDGET_EXHAUSTED'
    AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
    AND NEW.lease_until IS NOT DISTINCT FROM OLD.lease_until
    AND NEW.receipt IS NOT DISTINCT FROM OLD.receipt
    AND NEW.request_digest IS NOT DISTINCT FROM OLD.request_digest
  THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status<>'CLAIMED'
  THEN RAISE EXCEPTION 'S6 delivery result requires an owned claim'; END IF;
  IF OLD.status='CLAIMED' AND (NEW.lease_token IS DISTINCT FROM OLD.lease_token
    OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
    OR OLD.lease_until<=clock_timestamp())
  THEN RAISE EXCEPTION 'S6 stale delivery owner cannot persist a result'; END IF;
 END IF;
 RETURN NEW;
END $$;
