#!/usr/bin/env python3
"""Independent complete original and reconstructed quotient policy enumeration.
No production imports, signatures or cached producer expectations."""
import copy,itertools,json,sys
from fractions import Fraction
def q(v):
    if set(v)!={"numerator","denominator"} or int(v["denominator"])<=0:raise ValueError("oracle rational source")
    return Fraction(int(v["numerator"]),int(v["denominator"]))
def wire(v):return {"numerator":str(v.numerator),"denominator":str(v.denominator)}
def feasible(m,s):
    c=s["semantics"];r=c["resources"]
    if any(o["status"] in ("UNKNOWN","PARTIAL") for o in c["obligations"]) or any(v is None for v in c["terminalLiabilities"].values()):raise ValueError("oracle unknown: not infeasibility")
    for name in ("optionConditions","liquidity","covenants","staffing","compensation","employeeBenefits"):
        for row in c[name]:
            if row["schema"]!="finnor.exact-state-constraint.v1" or row["relation"] not in ("LE","GE","EQ"):raise ValueError("oracle unsupported constraint")
            a,b=q(row["left"]),q(row["right"])
            if not {"LE":a<=b,"GE":a>=b,"EQ":a==b}[row["relation"]]:return False
    if q(c["humanUsed"])>q(c["humanLimit"]) or q(c["computeUsed"])>q(c["computeLimit"]):return False
    for d in m["units"]["resources"]:
        if q(r["used"][d])+q(r["reserved"][d])>q(r["totalLimit"][d]) or any(q(v)>q(r["capacity"][d]) for v in r["occupancy"][d]):return False
    for w in s["worlds"]:
        u=r["worldUse"][w]
        if q(u["humanUsed"])>q(c["humanLimit"]) or q(u["computeUsed"])>q(c["computeLimit"]):return False
        for d in m["units"]["resources"]:
            if q(u["used"][d])+q(r["reserved"][d])>q(r["totalLimit"][d]) or any(q(v)>q(r["capacity"][d]) for v in u["occupancy"][d]):return False
        for row in r["couplings"]:
            for t in range(m["horizon"]["periods"]+1):
                if sum((q(u["occupancy"][d][t])*q(v) for d,v in row["weights"].items()),Fraction(0))>q(row["maximum"]):return False
    return True
def score(m,v):
    return min(v.values()) if m["uncertainty"]["kind"]=="FIXED_COMPLETE_WORLDS" else sum((v[w]*q(m["uncertainty"]["worldWeights"][w]) for w in v),Fraction(0))
def vectors(winners):return sorted(set(json.dumps({w:wire(v) for w,v in values.items()},sort_keys=True) for _,values in winners))
def enumerate_families(m):
    states={s["id"]:s for s in m["states"]};calls=[0];limit=1000000
    def complete(sid):
        calls[0]+=1
        if calls[0]>limit:raise ValueError("oracle declared complete enumeration bound")
        s=states[sid]
        if not feasible(m,s):return []
        if s["period"]==m["horizon"]["periods"]:return [({}, {w:q(v) for w,v in s["semantics"]["accruedUtility"].items()})]
        answers=[]
        for action in s["transitions"]:
            children=list(dict.fromkeys(t["successor"] for t in action["outcomes"]))
            children.sort(key=lambda cid:json.dumps([states[cid]["observations"],states[cid]["worlds"]],sort_keys=True,separators=(",",":")))
            for combination in itertools.product(*(complete(child) for child in children)):
                policy={sid:action["actionId"]};child_values={}
                for child,(choices,values) in zip(children,combination):
                    if any(k in policy and policy[k]!=v for k,v in choices.items()):break
                    policy.update(choices);child_values[child]=values
                else:
                    values={w:Fraction(0) for w in s["worlds"]}
                    for transition in action["outcomes"]:values[transition["worldId"]]+=q(transition["mass"])*child_values[transition["successor"]][transition["worldId"]]
                    if all(v>=q(m["economics"]["minimumUtility"]) for v in values.values()):
                        answers.append((policy,values))
                        if len(answers)>limit:raise ValueError("oracle complete policy count bound")
        return answers
    return {sid:complete(sid) for sid in states},calls[0]
def summarize(m,families,calls):
    out={}
    for sid,family in families.items():
        if not family:
            out[sid]={"status":"INFEASIBLE","feasiblePolicyCount":0,"optimum":None,"optimalActions":{},"optimalPolicyCount":0,"optimalWorldVectors":[]};continue
        maximum=max(score(m,v) for _,v in family);winners=[(p,v) for p,v in family if score(m,v)==maximum];choices={}
        for policy,_ in winners:
            for node,action in policy.items():choices.setdefault(node,set()).add(action)
        out[sid]={"status":"COMPLETE","feasiblePolicyCount":len(family),"optimum":wire(maximum),"optimalActions":{k:sorted(v) for k,v in choices.items()},"optimalPolicyCount":len(winners),"selectedWorldValues":{w:wire(v) for w,v in winners[0][1].items()},"optimalWorldVectors":vectors(winners)}
    return {"schema":"finnor.r1.independent-complete-policy-reference.v2","arithmetic":"PYTHON_FRACTION","states":out,"roots":m["roots"],"enumerationCalls":calls,"claim":"EXHAUSTIVE_REGISTERED_FINITE_MODELS_ONLY_NOT_ALL_PROFILE_GRAPHS_NOT_FIELD_ADMISSION"}
def quotient_from_original(m,c):
    originals={s["id"]:s for s in m["states"]};relation={}
    for b in c["blocks"]:
        if not b["members"]:raise ValueError("oracle empty class")
        for sid in b["members"]:
            if sid in relation or sid not in originals:raise ValueError("oracle relation coverage")
            relation[sid]=b["id"]
    if set(relation)!=set(originals):raise ValueError("oracle relation incomplete")
    out=copy.deepcopy(m);out["states"]=[];out["roots"]=[relation[r] for r in m["roots"]]
    for b in c["blocks"]:
        s=copy.deepcopy(originals[b["members"][0]]);s["id"]=b["id"]
        for t in s["transitions"]:
            grouped={}
            for e in t["outcomes"]:
                e["successor"]=relation[e["successor"]];mass=q(e.pop("mass"));k=json.dumps(e,sort_keys=True);grouped[k]=grouped.get(k,Fraction(0))+mass
            t["outcomes"]=[{**json.loads(k),"mass":wire(v)} for k,v in grouped.items()]
        out["states"].append(s)
    return out,relation
def lift_roots(m,qm,families,relation):
    originals={s["id"]:s for s in m["states"]};out={}
    def lift(sid,policy,choices):
        s=originals[sid]
        if s["period"]==m["horizon"]["periods"]:return
        action=policy[relation[sid]];choices[sid]=action;t=next(t for t in s["transitions"] if t["actionId"]==action)
        for cid in dict.fromkeys(e["successor"] for e in t["outcomes"]):lift(cid,policy,choices)
    for root in m["roots"]:
        family=families[relation[root]]
        if not family:
            out[root]={"status":"INFEASIBLE","optimum":None,"optimalActions":{},"optimalWorldVectors":[]};continue
        maximum=max(score(qm,v) for _,v in family);winners=[(p,v) for p,v in family if score(qm,v)==maximum];choices={}
        for policy,_ in winners:
            lifted={};lift(root,policy,lifted)
            for node,a in lifted.items():choices.setdefault(node,set()).add(a)
        out[root]={"status":"COMPLETE","optimum":wire(maximum),"optimalActions":{k:sorted(v) for k,v in choices.items()},"optimalWorldVectors":vectors(winners),"feasiblePolicyCount":len(family),"optimalPolicyCount":len(winners)}
    return out
def run(request):
    m=request.get("model",request);families,calls=enumerate_families(m);original=summarize(m,families,calls)
    if "candidate" not in request:return original
    qm,relation=quotient_from_original(m,request["candidate"]);qfamilies,qcalls=enumerate_families(qm);lifted=lift_roots(m,qm,qfamilies,relation)
    for root in m["roots"]:
        for field in ("status","optimum","optimalActions","optimalWorldVectors"):
            if original["states"][root][field]!=lifted[root][field]:raise ValueError("independent original/quotient/lift disagreement:"+root+":"+field)
    return {**original,"quotient":summarize(qm,qfamilies,qcalls),"liftedRoots":lifted,"basis":"ORIGINAL_FRACTION_COMPLETE_POLICIES_AND_CLASS_GRAPH_RECONSTRUCTED_FROM_ORIGINAL_TRANSITIONS"}
if __name__=="__main__":print(json.dumps(run(json.load(sys.stdin)),separators=(",",":")))
