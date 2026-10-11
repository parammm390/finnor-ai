"""Pre-code release diagnosis. The front-door oracle is a separate exact SCM."""
import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--python", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
output = pathlib.Path(args.output)
output.mkdir(parents=True, exist_ok=False)
script = r'''
import hashlib, itertools, json, pathlib, sys, importlib.metadata
from fractions import Fraction as F
import y0
from y0.dsl import Variable, Probability, Product, Sum, Fraction, One, Zero
from y0.graph import NxMixedGraph
from y0.algorithm.identify import identify_outcomes

X, M, Y = map(Variable, ["X", "M", "Y"])
graph = NxMixedGraph.from_edges(nodes=[X,M,Y], directed=[(X,M),(M,Y)], undirected=[(X,Y)])
expression = identify_outcomes(graph, treatments={X}, outcomes={Y})
joint = {}
for x,m,y in itertools.product([0,1], repeat=3):
    total=F(0)
    for u in [0,1]:
        px=F(1+2*u,4); pm=F(1+3*x,5); py=F(1+2*m+u,6)
        total += F(1,2)*(px if x else 1-px)*(pm if m else 1-pm)*(py if y else 1-py)
    joint[x,m,y]=total
def mass(names, assignment):
    indices={"X":0,"M":1,"Y":2}
    return sum((v for k,v in joint.items() if all(k[indices[n]]==assignment[n] for n in names)),F(0))
def evaluate(e, assignment):
    if isinstance(e,Probability):
        children=[v.name for v in e.children]; parents=[v.name for v in e.parents]
        return mass(children+parents,assignment)/mass(parents,assignment)
    if isinstance(e,Product):
        p=F(1)
        for term in e.expressions:p*=evaluate(term,assignment)
        return p
    if isinstance(e,Sum):
        ranges=sorted(v.name for v in e.ranges)
        return sum((evaluate(e.expression,{**assignment,**dict(zip(ranges,state))})
                    for state in itertools.product([0,1],repeat=len(ranges))),F(0))
    if isinstance(e,Fraction):return evaluate(e.numerator,assignment)/evaluate(e.denominator,assignment)
    if isinstance(e,One):return F(1)
    if isinstance(e,Zero):return F(0)
    raise TypeError(type(e).__name__)
raw=evaluate(expression,{"X":1,"Y":1})
# Independent SCM intervention: X is fixed, not drawn conditional on U.
truth=sum((F(1,2)*((F(4,5) if m else F(1,5)))*F(1+2*m+u,6) for u,m in itertools.product([0,1],repeat=2)),F(0))
# Independent front-door formula, explicitly stated before the adapter exists.
frontdoor=sum((mass(["M","X"],{"M":m,"X":1})/mass(["X"],{"X":1}) *
               sum((mass(["Y","M","X"],{"Y":1,"M":m,"X":x})/mass(["M","X"],{"M":m,"X":x}) *
                    mass(["X"],{"X":x}) for x in [0,1]),F(0)) for m in [0,1]),F(0))
assert frontdoor==truth
root=pathlib.Path(y0.__file__).parent
files={p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in
       ["algorithm/identify/api.py","algorithm/identify/id_std.py","algorithm/identify/id_c.py","dsl.py","graph.py"]}
print(json.dumps({"python":sys.version,"y0":importlib.metadata.version("y0"),"graph":{"directed":[["X","M"],["M","Y"]],"bidirected":[["X","Y"]]},
 "query":{"treatments":["X"],"outcomes":["Y"]},"positiveJoint":{str(k):str(v) for k,v in joint.items()},
 "rawExpression":expression.to_text(),"rawValue":str(raw),"independentSCM":str(truth),"independentFrontdoor":str(frontdoor),
 "releaseMismatch":raw!=truth,"sourceHashes":files,
 "diagnosis":"ID lines 6/7 form global P factors instead of chain factors of the recursive estimand; any accepted adapter must retain and independently verify that kernel."}))
'''
started = time.monotonic()
run = subprocess.run([args.python, "-I", "-c", script], text=True, capture_output=True,
                     timeout=180, env={"PATH": str(pathlib.Path(args.python).parent), "OPENBLAS_NUM_THREADS": "1"})
(output / "stderr.txt").write_text(run.stderr)
result = {"schema": "finnor.r4.y0-diagnosis.v1", "exitCode": run.returncode,
          "elapsedSeconds": time.monotonic() - started,
          "driverDigest": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
          "expected": "Independent front-door formula equals the SCM intervention, raw release mismatch is retained",
          "observed": json.loads(run.stdout) if run.returncode == 0 else run.stdout}
(output / "results.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"output": str(output), "exitCode": run.returncode}))
sys.exit(run.returncode)
