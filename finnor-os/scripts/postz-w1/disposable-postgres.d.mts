export interface DisposablePostgresObservation {
  schema: "finnor.w1.disposable-postgres-owner.v1";
  id: string;
  directory: string;
  databaseDirectory: string;
  uid: number;
  dev: number;
  ino: number;
  ownerPid: number;
  status: "NOT_CLEANED" | "PASS" | "FAIL";
  clusterStopped: boolean;
  directoryRemoved: boolean;
  failure?: string;
  completedAt?: string;
}

export interface DisposablePostgresOwner {
  readonly observation: DisposablePostgresObservation;
  cleanup(): DisposablePostgresObservation;
  attach<T>(instance: T): T;
}

export function ownDisposablePostgres(
  scratch: string, databaseDirectory?: string, receiptPath?: string,
): DisposablePostgresOwner;

export function closeDisposablePostgres(
  owner?: DisposablePostgresOwner, closers?: ReadonlyArray<() => unknown>,
): Promise<DisposablePostgresObservation | undefined>;
