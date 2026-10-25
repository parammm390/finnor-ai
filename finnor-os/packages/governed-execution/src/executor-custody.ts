/** An existing durable analytical owner supplies custody. This interface creates
 * no Work, plan, approval or financial-effect authority. */
export type ExecutorJournalStage = 'INTENT'|'SANDBOX_ACCEPTED'|'DISPATCH_INTENT'|'COMMAND_ACCEPTED'|'RESULT'|'DELETE_INTENT'|'DELETED';
export interface ExecutorJournalEntry {stage:ExecutorJournalStage;body:Record<string,unknown>}
export interface IsolatedExecutionCustody {
  /** Stable across queue delivery/claim changes, distinct for real analyses. */
  attemptKey:string;
  binding:{owner:'P1';tenantId:string;principalId:string;requestId:string;generation:number;workId:string;workInputId:string;moduleDigest:string;sourceDigest:string;inputDigest:string;consumer?:{owner:'P2'|'P6';id:string;digest:string}};
  originalDeadlineAt:string;
  read():Promise<ExecutorJournalEntry[]>;
  /** Atomically insert once. Return the original immutable entry on replay. */
  record(stage:ExecutorJournalStage,body:Record<string,unknown>):Promise<{created:boolean;body:Record<string,unknown>}>;
  /** Current original owner, source/Work/plan and real queue claim at egress. */
  assertCurrent():Promise<void>;
}
export interface IsolatedExecutionOptions {backend?:'local'|'daytona';custody?:IsolatedExecutionCustody}
