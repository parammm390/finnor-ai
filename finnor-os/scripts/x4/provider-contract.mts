/** Wire shapes only. No fixture implementation, oracle, constants or evaluator. */
export type Role = "analyst" | "auditor";
export type TrialRecord = {
  id: string;
  features: Record<string, number>;
  value: string;
};
export type Trial = {
  id: string;
  instanceId: string;
  applicationVersion: string;
  role: Role;
  controls: { updateTiming: -1 | 1 | 3; pageSize: 1 | 2 | 4 };
  records: TrialRecord[];
};
export type OperationEvent = {
  sequence: number;
  id: string;
  type: "accepted" | "records-prepared" | "records-updated" | "started"
    | "completed" | "output-written" | "failed" | "post-received";
  at: string;
  recordIds: string[];
  detail?: string;
};
export type OperationReadback = {
  id: string;
  instanceId: string;
  applicationVersion: string;
  role: Role;
  status: "PENDING" | "COMPLETE" | "FAILED";
  delivered: Trial;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  events: OperationEvent[];
  units: "count";
  failure?: string;
};
export type ObservationRecord = { id: string; value: string };
export type ObservationPage = {
  experimentId: string;
  instanceId: string;
  applicationVersion: string;
  role: Role;
  // Deliberately not a "count" literal: an invalid instrument can report another unit.
  units: string;
  available: boolean;
  records: ObservationRecord[];
  nextCursor: string | null;
  observedAt: string;
  completedAt: string | null;
  displayedPageCount?: number;
  timing?: {
    requestedAt: string;
    startedAt: string;
    completedAt: string;
    events: { id: string; type: string; at: string }[];
  };
};
export type CalibrationDescriptor = {
  id: string;
  role: Role | "any";
  semantics: string;
  expectedDisposition: "ACCEPT" | "REJECT" | "MISSING";
  expectedStatus: number;
  expectedUnits: "count";
  expectedRecords: ObservationRecord[];
  expectedFault?: string;
  expectedTiming?: NonNullable<ObservationPage["timing"]>;
};
