/** Independent public-fixture oracle. No production compiler/optimizer imports. */
export function publicReference(capTenths: bigint, reserved: bigint) {
  const rows = [
    {id:'A',ev:120n,ebitda:20n,debt:70n,payoff:20n},
    {id:'B',ev:100n,ebitda:25n,debt:50n,payoff:18n},
    {id:'C',ev:90n,ebitda:15n,debt:45n,payoff:14n},
  ].map(row => ({...row,debt:row.debt*10n<=row.ebitda*capTenths?row.debt:row.ebitda*capTenths/10n}));
  const feasible = [];
  for (let mask=0;mask<8;mask++) {
    const chosen=rows.filter((_,i)=>(mask&(1<<i))!==0);
    const equity=chosen.reduce((n,row)=>n+row.ev-row.debt,0n);
    if (equity<=95n-reserved) feasible.push({
      selected:chosen.map(r=>r.id),
      payoff:chosen.reduce((n,row)=>n+row.payoff,0n),
      equity,
    });
  }
  feasible.sort((a,b)=>a.payoff>b.payoff?-1:a.payoff<b.payoff?1:0);
  return {rows:rows.map(row=>({...row,ev:String(row.ev),ebitda:String(row.ebitda),debt:String(row.debt),equity:String(row.ev-row.debt),payoff:String(row.payoff)})),
    ...feasible[0]!,payoff:String(feasible[0]!.payoff),equity:String(feasible[0]!.equity)};
}
