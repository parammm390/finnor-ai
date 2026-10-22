-- Keep the existing episode, authority revision, effects and audit history.
-- Historical requests without the captured S1 temporal cut cannot acquire one
-- from today's rights; only their future use is invalidated.
UPDATE finnor_os.y1_requests r SET status='INVALIDATED',generation=generation+1
 WHERE r.status NOT IN('INVALIDATED','CANCELLED') AND NOT r.cancelled
  AND NOT EXISTS(SELECT 1 FROM finnor_os.y1_events e
   WHERE e.tenant_id=r.tenant_id AND e.theory_id=r.id AND e.event_key='accepted'
    AND e.kind='ACCEPTED' AND e.body->'authority' ? 'validUntil'
    AND e.body->'authority'->>'employeeId'=r.principal_id::text
    AND e.body->'authority'->>'revision'=r.rights_revision);
