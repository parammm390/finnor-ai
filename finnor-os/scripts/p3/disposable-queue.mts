/** Select a test delivery without adding a production queue authority seam. */
export async function selectedBranch<T>(admin: any, branchId: string, invoke: () => Promise<T>) {
  const target = (await admin.query('SELECT job_id FROM finnor_os.p3_requests WHERE id=$1', [branchId])).rows[0];
  if (!target?.job_id) throw Error('DISPOSABLE_BRANCH_JOB_REQUIRED');
  const deferred = (await admin.query(`SELECT id,run_at FROM finnor_os.jobs
    WHERE status='queued' AND type='run_branch_fabric_v1' AND id<>$1`, [target.job_id])).rows;
  if (deferred.length) await admin.query(`UPDATE finnor_os.jobs SET run_at=clock_timestamp()+interval '1 hour'
    WHERE id=ANY($1::uuid[]) AND status='queued'`, [deferred.map((row: any) => row.id)]);
  try { return await invoke(); }
  finally {
    for (const row of deferred) await admin.query("UPDATE finnor_os.jobs SET run_at=$2 WHERE id=$1 AND status='queued'",
      [row.id, row.run_at]);
  }
}
