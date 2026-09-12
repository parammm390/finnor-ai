import { P8_WATER_TENANT_DISPOSITIONS } from "./p8-water-retirement-policy.mjs"

function statusMap(rows, section) {
  return Object.fromEntries(
    rows
      .filter((row) => row.section === section)
      .map((row) => [row.state, Number(row.count)]),
  )
}

export async function readWaterOperationalCensus(client, {
  tenantIds = P8_WATER_TENANT_DISPOSITIONS.map((row) => row.tenantId),
} = {}) {
  const grouped = await client.query(
    `SELECT 'works' AS section,status AS state,count(*)::int AS count
       FROM finnor_os.works WHERE tenant_id=ANY($1::uuid[]) GROUP BY status
     UNION ALL
     SELECT 'domainActions',status,count(*)::int
       FROM finnor_os.domain_actions WHERE tenant_id=ANY($1::uuid[]) GROUP BY status
     UNION ALL
     SELECT 'jobs',status,count(*)::int
       FROM finnor_os.jobs WHERE finnor_os.is_retired_water_job(type,payload) GROUP BY status
     UNION ALL
     SELECT 'workflowRuns',status,count(*)::int
       FROM finnor_os.workflow_runs WHERE tenant_id=ANY($1::uuid[]) GROUP BY status
     UNION ALL
     SELECT 'workflowSteps',status,count(*)::int
       FROM finnor_os.workflow_steps WHERE tenant_id=ANY($1::uuid[]) GROUP BY status
     UNION ALL
     SELECT 'outboxEvents',status,count(*)::int
       FROM finnor_os.outbox_events WHERE tenant_id=ANY($1::uuid[]) GROUP BY status
     UNION ALL
     SELECT 'businessEffects',status,count(*)::int
       FROM finnor_os.business_effects WHERE tenant_id=ANY($1::uuid[]) GROUP BY status
     UNION ALL
     SELECT 'objectiveLoops',state,count(*)::int
       FROM finnor_os.work_objective_loops WHERE tenant_id=ANY($1::uuid[]) GROUP BY state
     UNION ALL
     SELECT 'eventWaits',status,count(*)::int
       FROM finnor_os.work_event_waits WHERE tenant_id=ANY($1::uuid[]) GROUP BY status
     UNION ALL
     SELECT 'externalOperations',status,count(*)::int
       FROM finnor_os.external_operations WHERE tenant_id=ANY($1::uuid[]) GROUP BY status
     UNION ALL
     SELECT 'integrationOperations',status,count(*)::int
       FROM finnor_os.integration_operations WHERE tenant_id=ANY($1::uuid[]) GROUP BY status
     UNION ALL
     SELECT 'computerRuns',status,count(*)::int
       FROM finnor_os.computer_runs WHERE tenant_id=ANY($1::uuid[]) GROUP BY status
     UNION ALL
     SELECT 'sandboxOutbox',channel,count(*)::int
       FROM finnor_os.sandbox_outbox WHERE tenant_id=ANY($1::uuid[]) GROUP BY channel
     UNION ALL
     SELECT 'messages',direction||':'||channel,count(*)::int
       FROM finnor_os.messages WHERE tenant_id=ANY($1::uuid[]) GROUP BY direction,channel
     ORDER BY 1,2`,
    [tenantIds],
  )
  const counts = (await client.query(
    `SELECT
       (SELECT count(*)::int FROM finnor_os.works
         WHERE tenant_id=ANY($1::uuid[]) AND status NOT IN ('completed','failed','cancelled')) AS nonterminal_work,
       (SELECT count(*)::int FROM finnor_os.domain_actions
         WHERE tenant_id=ANY($1::uuid[]) AND status IN ('draft','pending','approved','executing','needs_human_review','blocked_integration_unavailable')) AS active_domain_actions,
       (SELECT count(*)::int FROM finnor_os.jobs
         WHERE finnor_os.is_retired_water_job(type,payload) AND status IN ('queued','running')) AS queued_or_running_jobs,
       (SELECT count(*)::int FROM finnor_os.jobs
         WHERE finnor_os.is_retired_water_job(type,payload) AND status='queued' AND run_at>now()) AS scheduled_jobs,
       (SELECT count(*)::int FROM finnor_os.workflow_runs
         WHERE tenant_id=ANY($1::uuid[]) AND status IN ('running','compensating','paused')) AS active_workflow_runs,
       (SELECT count(*)::int FROM finnor_os.workflow_steps
         WHERE tenant_id=ANY($1::uuid[]) AND status IN ('pending','leased','compensating')) AS active_workflow_steps,
       (SELECT count(*)::int FROM finnor_os.outbox_events
         WHERE tenant_id=ANY($1::uuid[]) AND status IN ('pending','delivering','unknown')) AS active_outbox_events,
       (SELECT count(*)::int FROM finnor_os.business_effects
         WHERE tenant_id=ANY($1::uuid[]) AND status IN ('compiled','authorized','executing','unverified','reconciliation_required')) AS active_business_effects,
       (SELECT count(*)::int FROM finnor_os.work_objective_loops
         WHERE tenant_id=ANY($1::uuid[]) AND state IN ('continue','awaiting_approval','waiting')) AS scheduled_objective_loops,
       (SELECT count(*)::int FROM finnor_os.work_event_waits
         WHERE tenant_id=ANY($1::uuid[]) AND status='waiting') AS active_event_waits,
       (SELECT count(*)::int FROM finnor_os.conversations
         WHERE tenant_id=ANY($1::uuid[]) AND status='open') AS open_conversations,
       (SELECT count(*)::int FROM finnor_os.calls
         WHERE tenant_id=ANY($1::uuid[]) AND started_at IS NOT NULL AND ended_at IS NULL) AS open_calls,
       (SELECT count(*)::int FROM finnor_os.calls
         WHERE tenant_id=ANY($1::uuid[])) AS historical_calls,
       (SELECT count(*)::int FROM finnor_os.messages
         WHERE tenant_id=ANY($1::uuid[])) AS historical_messages,
       (SELECT count(*)::int FROM finnor_os.sandbox_outbox
         WHERE tenant_id=ANY($1::uuid[])) AS historical_sandbox_outbox,
       (SELECT count(*)::int FROM finnor_os.canonical_truth_registry
         WHERE active AND (vertical_key='water' OR entity_type IN ('business_operation','business_operation_target'))) AS active_legacy_truth_rows,
       (SELECT count(*)::int FROM finnor_os.canonical_truth_registry
         WHERE work_attachable AND vertical_key='water') AS attachable_water_truth_rows,
       (SELECT count(*)::int FROM finnor_os.domain_policies
         WHERE active AND (finnor_os.is_retired_water_action(action_type) OR tenant_id=ANY($1::uuid[]))) AS active_water_policies,
       (SELECT count(*)::int FROM finnor_os.tenant_settings
         WHERE tenant_id=ANY($1::uuid[]) AND (is_dealer_zero OR simulator_enabled OR training_mode)) AS enabled_legacy_tenant_modes`,
    [tenantIds],
  )).rows[0]
  const verticals = (await client.query(
    `SELECT key,active FROM finnor_os.vertical_definitions
      WHERE key IN ('water','private_equity') ORDER BY key`,
  )).rows
  return {
    tenantIds: [...tenantIds].sort(),
    byStatus: {
      works: statusMap(grouped.rows, "works"),
      domainActions: statusMap(grouped.rows, "domainActions"),
      jobs: statusMap(grouped.rows, "jobs"),
      workflowRuns: statusMap(grouped.rows, "workflowRuns"),
      workflowSteps: statusMap(grouped.rows, "workflowSteps"),
      outboxEvents: statusMap(grouped.rows, "outboxEvents"),
      businessEffects: statusMap(grouped.rows, "businessEffects"),
      objectiveLoops: statusMap(grouped.rows, "objectiveLoops"),
      eventWaits: statusMap(grouped.rows, "eventWaits"),
      externalOperations: statusMap(grouped.rows, "externalOperations"),
      integrationOperations: statusMap(grouped.rows, "integrationOperations"),
      computerRuns: statusMap(grouped.rows, "computerRuns"),
      sandboxOutbox: statusMap(grouped.rows, "sandboxOutbox"),
      messages: statusMap(grouped.rows, "messages"),
    },
    live: {
      nonterminalWork: Number(counts.nonterminal_work),
      activeDomainActions: Number(counts.active_domain_actions),
      queuedOrRunningJobs: Number(counts.queued_or_running_jobs),
      scheduledJobs: Number(counts.scheduled_jobs),
      activeWorkflowRuns: Number(counts.active_workflow_runs),
      activeWorkflowSteps: Number(counts.active_workflow_steps),
      activeOutboxEvents: Number(counts.active_outbox_events),
      activeBusinessEffects: Number(counts.active_business_effects),
      scheduledObjectiveLoops: Number(counts.scheduled_objective_loops),
      activeEventWaits: Number(counts.active_event_waits),
      openConversations: Number(counts.open_conversations),
      openCalls: Number(counts.open_calls),
    },
    historicalCommunications: {
      calls: Number(counts.historical_calls),
      messages: Number(counts.historical_messages),
      sandboxOutbox: Number(counts.historical_sandbox_outbox),
    },
    legacyCanonical: {
      verticals: Object.fromEntries(verticals.map((row) => [row.key, row.active])),
      activeTruthRows: Number(counts.active_legacy_truth_rows),
      attachableWaterTruthRows: Number(counts.attachable_water_truth_rows),
      activeWaterPolicies: Number(counts.active_water_policies),
      enabledTenantModes: Number(counts.enabled_legacy_tenant_modes),
    },
  }
}

export async function writeTenantDispositions(client, { actor, authorizationRef }) {
  const obligations = JSON.stringify([
    "preserve_historical_truth",
    "prevent_future_water_execution",
    "terminalize_only_audited_test_or_synthetic_work",
  ])
  for (const disposition of P8_WATER_TENANT_DISPOSITIONS) {
    await client.query(
      `INSERT INTO finnor_os.water_tenant_retirement_dispositions
         (tenant_id,classification,authorized,authorization_ref,obligations,classified_by,classified_at,updated_at)
       VALUES ($1,$2,true,$3,$4::jsonb,$5,now(),now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         classification=EXCLUDED.classification,authorized=true,
         authorization_ref=EXCLUDED.authorization_ref,obligations=EXCLUDED.obligations,
         classified_by=EXCLUDED.classified_by,updated_at=now()`,
      [disposition.tenantId, disposition.classification, authorizationRef, obligations, actor],
    )
  }
}

export async function drainAuditedWaterFixtures(client, {
  actor,
  authorizationRef,
  releaseSha,
  tenantIds = P8_WATER_TENANT_DISPOSITIONS.map((row) => row.tenantId),
}) {
  const actions = await client.query(
    `WITH targets AS MATERIALIZED (
       SELECT id,tenant_id,status
         FROM finnor_os.domain_actions
        WHERE tenant_id=ANY($1::uuid[])
          AND status IN ('draft','pending','approved','executing','needs_human_review','blocked_integration_unavailable')
        FOR UPDATE
     ), changed AS (
       UPDATE finnor_os.domain_actions a
          SET status=CASE WHEN t.status IN ('executing','blocked_integration_unavailable') THEN 'failed' ELSE 'rejected' END
         FROM targets t WHERE a.id=t.id
       RETURNING a.id,a.tenant_id,a.status,t.status AS previous_status
     ), logged AS (
       INSERT INTO finnor_os.action_log(tenant_id,domain_action_id,step,input,output)
       SELECT tenant_id,id,status,
              jsonb_build_object('by',$2::text,'role','release-operator','reason','phase8_water_retirement'),
              jsonb_build_object('previousStatus',previous_status,'authorizationRef',$3::text,'releaseSha',$4::text)
         FROM changed
       RETURNING id
     )
     SELECT count(*)::int AS terminalized,
            count(*) FILTER (WHERE status='rejected')::int AS rejected,
            count(*) FILTER (WHERE status='failed')::int AS failed,
            (SELECT count(*)::int FROM logged) AS audit_rows
       FROM changed`,
    [tenantIds, actor, authorizationRef, releaseSha],
  )
  const effects = await client.query(
    `UPDATE finnor_os.business_effects e
        SET status=CASE WHEN status IN ('compiled','authorized') THEN 'cancelled' ELSE 'failed' END,
            verification=coalesce(verification,'{}'::jsonb)||jsonb_build_object(
              'state','retired','basis','Phase 8 Water retirement of audited test/synthetic fixture',
              'authorizationRef',$2::text,'releaseSha',$3::text,'checkedAt',now()
            )
      WHERE tenant_id=ANY($1::uuid[])
        AND status IN ('compiled','authorized','executing','unverified','reconciliation_required')
      RETURNING id`,
    [tenantIds, authorizationRef, releaseSha],
  )
  const objectives = await client.query(
    `UPDATE finnor_os.work_objective_loops
        SET state='cancelled',reason='Phase 8 Water retirement of audited test/synthetic fixture',
            next_run_at=NULL,lease_owner=NULL,lease_until=NULL,
            completed_at=now(),cancelled_at=now(),updated_at=now()
      WHERE tenant_id=ANY($1::uuid[])
        AND state IN ('continue','awaiting_approval','waiting')
      RETURNING id`,
    [tenantIds],
  )
  const jobs = await client.query(
    `UPDATE finnor_os.jobs
        SET status='quarantined',last_error='RETIRED_VERTICAL: Phase 8 retired audited test/synthetic Water work',
            lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,completed_at=coalesce(completed_at,now())
      WHERE finnor_os.is_retired_water_job(type,payload)
        AND status IN ('queued','running','failed')
      RETURNING id`,
  )
  const works = await client.query(
    `WITH targets AS MATERIALIZED (
       SELECT id,tenant_id,status
         FROM finnor_os.works
        WHERE tenant_id=ANY($1::uuid[])
          AND status NOT IN ('completed','failed','cancelled')
        FOR UPDATE
     ), changed AS (
       UPDATE finnor_os.works w
          SET status='cancelled',
              final_outcome=jsonb_build_object(
                'kind','cancelled','reason','phase8_water_retirement',
                'authorizationRef',$2::text,'releaseSha',$3::text
              ),
              updated_at=now()
         FROM targets t WHERE w.id=t.id
       RETURNING w.id,w.tenant_id,t.status AS previous_status
     ), events AS (
       INSERT INTO finnor_os.work_events(tenant_id,work_id,seq,event_type,from_status,to_status,payload)
       SELECT c.tenant_id,c.id,
              coalesce((SELECT max(existing.seq) FROM finnor_os.work_events existing WHERE existing.work_id=c.id),0)+1,
              'phase8_water_retirement',c.previous_status,'cancelled',
              jsonb_build_object('by',$4::text,'authorizationRef',$2::text,'releaseSha',$3::text)
         FROM changed c
       RETURNING id
     )
     SELECT count(*)::int AS cancelled,(SELECT count(*)::int FROM events) AS audit_rows FROM changed`,
    [tenantIds, authorizationRef, releaseSha, actor],
  )
  return {
    actions: actions.rows[0] ?? { terminalized: 0, rejected: 0, failed: 0, audit_rows: 0 },
    effects: effects.rowCount,
    objectives: objectives.rowCount,
    jobs: jobs.rowCount,
    works: works.rows[0] ?? { cancelled: 0, audit_rows: 0 },
  }
}
