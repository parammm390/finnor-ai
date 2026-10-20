/** Public development oracle, transcribed from the independently preregistered
 * literals. Only the evaluator imports this file. No training labels or
 * expectations from these assignments enter the controller. */
export interface DevelopmentCase {
 id:string;stratum:'TRANSFER'|'RETENTION'|'BOUNDARY';currency:string;
 lines:readonly string[];total:string;approvals:number;
 delayed?:boolean;stale?:boolean;boundary?:string;
}
const rows:readonly (readonly [string,string,readonly string[],string,number])[]=[
 ['F01','USD',['3100','4900'],'8000',1],['F02','INR',['16000','14000'],'30000',1],
 ['F03','USD',['49998','1'],'49999',1],['F04','USD',['49999','1'],'50000',2],
 ['F05','INR',['50000','1'],'50001',2],['F06','USD',['9007199254741000','9'],'9007199254741009',2],
 ['F07','INR',['80000','120000'],'200000',2],['F08','USD',['0','0'],'0',1],
 ['F09','USD',['6000','1250'],'7250',1],['F10','INR',['21000','2000'],'23000',1],
 ['F11','USD',['48000','6000'],'54000',2],['F12','INR',['70000','30000'],'100000',2],
 ['F13','USD',['1','999'],'1000',1],['F14','INR',['15000','25000','9999'],'49999',1],
 ['F15','USD',['20000','20000','10000'],'50000',2],['F16','INR',['10000000000000000000000000','7'],'10000000000000000000000007',2],
 ['R01','USD',['1400','2600'],'4000',1],['R02','INR',['30000','69999'],'99999',1],
 ['R03','USD',['60000','40000'],'100000',2],['R04','INR',['100000','9'],'100009',2],
 ['R05','USD',['9007199254741010','1'],'9007199254741011',2],['R06','USD',['45','55'],'100',1],
 ['R07','INR',['12345','54321'],'66666',1],['R08','USD',['0','1'],'1',1],
];
export const DEVELOPMENT_CASES:readonly DevelopmentCase[]=Object.freeze([
 ...rows.map(([id,currency,lines,total,approvals])=>({
  id,currency,lines,total,approvals,stratum:id.startsWith('R')?'RETENTION' as const:'TRANSFER' as const,
  delayed:['F09','F10','F11','F12','R06'].includes(id),stale:id==='R07',
 })),
 ...[
  ['C01',['4100','900'],'5000','CONTROL_TOTAL_MISMATCH'],['C02',['4100','900'],'5000','REAL_NATIVE_FALLBACK'],
  ['N01',['12345','5'],'12349','AMOUNT_MISMATCH'],['N02',['3100','4900'],'8000','CURRENCY_MISMATCH'],
  ['N03',['3100','4900'],'8000','TIME_MISMATCH'],['N04',['3100','4900'],'8000','SOURCE_STALE'],
  ['N05',['3100','4900'],'8000','SELF_APPROVAL_DENIED'],['N06',[],'','PENDING_CANONICAL_OBLIGATION'],
 ].map(([id,lines,total,boundary])=>({id:id as string,lines:lines as string[],total:total as string,boundary:boundary as string,
  currency:'USD',approvals:id==='C02'?1:0,stratum:'BOUNDARY' as const})),
]);
/** Canonical assignment clock, with bounded wire/transaction-clock slack. */
export const DEVELOPMENT_OBSERVATION_SCHEDULE=Object.freeze({delayMs:8000,toleranceMs:500});
export const DEVELOPMENT_PLAN=Object.freeze({cases:DEVELOPMENT_CASES,observationSchedule:DEVELOPMENT_OBSERVATION_SCHEDULE});
