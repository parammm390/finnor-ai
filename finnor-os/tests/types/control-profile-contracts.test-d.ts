import type {
  ControlProblem, NetProfitAccounting, OperatingProfitObjective, OperatingProgrammeSpace, RevenueProfitTarget,
} from '../../packages/shared-types/src/contingent-control';

type Assert<T extends true> = T;
type Accepts<Input, Contract> = [Input] extends [Contract] ? true : false;
type Rejects<Input, Contract> = Accepts<Input, Contract> extends false ? true : false;
type AccountingFields = Omit<OperatingProfitObjective, 'objective' | 'netProfit' | 'profitTarget'>;
type ControlFields = Omit<ControlProblem, 'schema' | 'programmeSpace' | 'exactSource' | 'continuation' | 'observations'> & { observations: [] };

type ValidOperating = Assert<Accepts<AccountingFields & { objective: 'INCREMENTAL_OPERATING_PROFIT' }, OperatingProfitObjective>>;
type ValidNet = Assert<Accepts<AccountingFields & { objective: 'INCREMENTAL_NET_PROFIT'; netProfit: NetProfitAccounting; profitTarget: RevenueProfitTarget }, OperatingProfitObjective>>;
type MissingNetAccounting = Assert<Rejects<AccountingFields & { objective: 'INCREMENTAL_NET_PROFIT' }, OperatingProfitObjective>>;
type UnexpectedNetAccounting = Assert<Rejects<AccountingFields & { objective: 'INCREMENTAL_FREE_CASH_FLOW'; netProfit: NetProfitAccounting }, OperatingProfitObjective>>;
type TargetOnOperatingProfit = Assert<Rejects<AccountingFields & { objective: 'INCREMENTAL_OPERATING_PROFIT'; profitTarget: RevenueProfitTarget }, OperatingProfitObjective>>;

type ValidLegacy = Assert<Accepts<ControlFields & { schema: 'finnor.control-problem.v1' }, ControlProblem>>;
type ValidProgramme = Assert<Accepts<ControlFields & { schema: 'finnor.control-problem.operating-programme.v2'; programmeSpace: OperatingProgrammeSpace }, ControlProblem>>;
type ValidExact = Assert<Accepts<ControlFields & { schema: 'finnor.control-problem.exact.v2'; exactSource: NonNullable<ControlProblem['exactSource']> }, ControlProblem>>;
type MissingProgramme = Assert<Rejects<ControlFields & { schema: 'finnor.control-problem.operating-programme.v2' }, ControlProblem>>;
type MixedLegacy = Assert<Rejects<ControlFields & { schema: 'finnor.control-problem.v1'; programmeSpace: OperatingProgrammeSpace }, ControlProblem>>;
type MissingExactSource = Assert<Rejects<ControlFields & { schema: 'finnor.control-problem.exact.v2' }, ControlProblem>>;
type ProgrammeContinuation = Assert<Rejects<ControlFields & { schema: 'finnor.control-problem.operating-programme.v2'; programmeSpace: OperatingProgrammeSpace; continuation: NonNullable<ControlProblem['continuation']> }, ControlProblem>>;
