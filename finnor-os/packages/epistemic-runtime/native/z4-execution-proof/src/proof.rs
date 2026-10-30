use crate::{
    model::{statement_binding, execute, i64_value, integer, validate_program, validate_request, Program, Request, Statement, BACKEND, COMPILER, LENGTHS, MAX_BYTES, PROFILE},
    plan::{compile, Gate, Linear, Plan, Recipe},
};
use ff::{Field, PrimeField};
use nova_snark::{
    frontend::{num::AllocatedNum, ConstraintSystem, LinearCombination, SynthesisError},
    nova::{CompressedSNARK, PublicParams, RecursiveSNARK, ProverKey, VerifierKey},
    provider::{PallasEngine, VestaEngine},
    traits::{circuit::StepCircuit, snark::RelaxedR1CSSNARKTrait, Engine, ROCircuitTrait, ROTrait, ROMode, RO2Constants},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::{Arc, OnceLock}, time::Instant};

pub type E1 = PallasEngine;
pub type E2 = VestaEngine;
pub type F = <E1 as Engine>::Scalar;
type S1 = nova_snark::spartan::snark::RelaxedR1CSSNARK<E1, nova_snark::provider::ipa_pc::EvaluationEngine<E1>>;
type S2 = nova_snark::spartan::snark::RelaxedR1CSSNARK<E2, nova_snark::provider::ipa_pc::EvaluationEngine<E2>>;
type PP = PublicParams<E1, E2, IntegerCircuit>;
type PK = ProverKey<E1, E2, IntegerCircuit, S1, S2>;
type VK = VerifierKey<E1, E2, IntegerCircuit, S1, S2>;
type Proof = CompressedSNARK<E1, E2, IntegerCircuit, S1, S2>;

pub fn hash_bytes(v: &[u8]) -> String { hex::encode(Sha256::digest(v)) }
pub fn hash_json<T: Serialize>(v: &T) -> String {
    hash_bytes(&serde_json::to_vec(&serde_json::to_value(v).unwrap()).unwrap())
}
pub fn scalar(n: i128) -> F {
    let u = n.unsigned_abs();
    let two64 = F::from(u64::MAX) + F::ONE;
    let f = F::from(u as u64) + F::from((u >> 64) as u64) * two64;
    if n < 0 { -f } else { f }
}
fn as_integer(f: F) -> Option<i128> {
    fn magnitude(f: F) -> Option<u128> {
        let r = f.to_repr();
        let b = r.as_ref();
        if b[16..].iter().any(|x| *x != 0) { return None; }
        Some(u128::from_le_bytes(b[..16].try_into().unwrap()))
    }
    if let Some(n) = magnitude(f).filter(|n| *n <= i128::MAX as u128) { return Some(n as i128); }
    magnitude(-f).filter(|n| *n <= i128::MAX as u128).map(|n| -(n as i128))
}
pub fn scalar_hex(f: F) -> String { hex::encode(f.to_repr().as_ref()) }
fn from_hex(v: &str) -> Result<F, String> {
    if v.len() != 64 || v.bytes().any(|b| !b.is_ascii_digit() && !(b'a'..=b'f').contains(&b)) { return Err("Z4_SCALAR_ENCODING".into()); }
    let raw = hex::decode(v).map_err(|_| "Z4_SCALAR_ENCODING")?;
    let mut repr = <F as PrimeField>::Repr::default();
    repr.as_mut().copy_from_slice(&raw);
    Option::<F>::from(F::from_repr(repr)).ok_or("Z4_NONCANONICAL_SCALAR".into())
}
fn ro_constants() -> RO2Constants<E1> {
    static CONSTANTS: OnceLock<RO2Constants<E1>> = OnceLock::new();
    CONSTANTS.get_or_init(Default::default).clone()
}
fn hash_inputs(v: &[F]) -> F {
    let mut ro = <E1 as Engine>::RO2::new_with_mode(ro_constants(), ROMode::Wide);
    for x in v { ro.absorb(*x); }
    ro.squeeze(250, false)
}
pub fn commitment(r: &Request) -> Result<String, String> {
    validate_request(r)?;
    let mut acc = F::ZERO;
    for (i, row) in r.inputs.iter().enumerate() {
        let mut v = vec![F::from(1513376049), F::from(i as u64), acc];
        for x in row { v.push(scalar(integer(x)?)); }
        acc = hash_inputs(&v);
    }
    Ok(scalar_hex(acc))
}

#[derive(Clone, Debug)]
pub struct IntegerCircuit { pub plan: Arc<Plan>, pub input: Vec<i128> }
#[derive(Clone, Copy)]
struct Value { f: Option<F>, n: Option<i128> }
impl Value {
    fn field(f: Option<F>) -> Self { Self { f, n: f.and_then(as_integer) } }
    fn number(n: Option<i128>) -> Self { Self { f: n.map(scalar), n } }
}
fn witness(recipe: &Recipe, values: &BTreeMap<String, Value>, input: &[i128]) -> Value {
    let get = |s: &String| values[s];
    match recipe {
        Recipe::External { .. } => unreachable!(),
        Recipe::Input { index } => Value::number(input.get(*index).copied()),
        Recipe::Constant { value } => Value::number(Some(value.parse().unwrap())),
        Recipe::Linear { terms } => {
            let f = terms.iter().try_fold(F::ZERO, |acc, (w, c)| Some(acc + values[w].f? * scalar(c.parse().unwrap())));
            let n = terms.iter().try_fold(0i128, |acc, (w, c)| acc.checked_add(values[w].n?.checked_mul(c.parse().unwrap())?));
            Value { f, n }
        }
        Recipe::Product { a, b } => Value { f: get(a).f.zip(get(b).f).map(|(a,b)| a*b), n: get(a).n.zip(get(b).n).and_then(|(a,b)| a.checked_mul(b)) },
        Recipe::Bit { source, bit, offset } => Value::number(get(source).n.and_then(|n| n.checked_add(offset.parse().unwrap())).map(|n| (n >> bit) & 1)),
        Recipe::Equal { a, b } => Value::number(get(a).f.zip(get(b).f).map(|(a,b)| i128::from(a == b))),
        Recipe::Inverse { a, b } => Value { f: get(a).f.zip(get(b).f).map(|(a,b)| Option::<F>::from((a-b).invert()).unwrap_or(F::ZERO)), n: None },
        Recipe::Select { a, b, c } => {
            if let Some(c) = get(c).n { if c == 1 { get(a) } else { get(b) } } else { Value { f: None, n: None } }
        }
        Recipe::Hash { inputs } => Value { f: inputs.iter().map(|s| values[s].f).collect::<Option<Vec<_>>>().map(|v| hash_inputs(&v)), n: None },
    }
}
fn lc<CS: ConstraintSystem<F>>(terms: &Linear, vars: &BTreeMap<String, AllocatedNum<F>>) -> LinearCombination<F> {
    let mut lc = LinearCombination::zero();
    for (name, c) in terms {
        let var = if name == "one" { CS::one() } else { vars[name].get_variable() };
        lc = lc + (scalar(c.parse().unwrap()), var);
    }
    lc
}
impl StepCircuit<F> for IntegerCircuit {
    fn arity(&self) -> usize { 14 }
    fn synthesize<CS: ConstraintSystem<F>>(&self, cs: &mut CS, z: &[AllocatedNum<F>]) -> Result<Vec<AllocatedNum<F>>, SynthesisError> {
        let mut vars = BTreeMap::new();
        let mut values = BTreeMap::from([("one".to_string(), Value::number(Some(1)))]);
        for wire in &self.plan.wires {
            if let Recipe::External { index } = wire.recipe {
                vars.insert(wire.name.clone(), z[index].clone());
                values.insert(wire.name.clone(), Value::field(z[index].get_value()));
            } else {
                let v = witness(&wire.recipe, &values, &self.input);
                let var = AllocatedNum::alloc(cs.namespace(|| wire.name.clone()), || v.f.ok_or(SynthesisError::AssignmentMissing))?;
                vars.insert(wire.name.clone(), var);
                values.insert(wire.name.clone(), v);
            }
        }
        for (index, gate) in self.plan.gates.iter().enumerate() {
            match gate {
                Gate::R1cs { a, b, c } => {
                    let a = lc::<CS>(a, &vars); let b = lc::<CS>(b, &vars); let c = lc::<CS>(c, &vars);
                    cs.enforce(|| format!("gate{index}"), |_| a, |_| b, |_| c);
                }
                Gate::Poseidon250 { inputs, output } => {
                    let mut ro = <E1 as Engine>::RO2Circuit::new_with_mode(ro_constants(), ROMode::Wide);
                    for w in inputs { ro.absorb(&vars[w]); }
                    let bits = ro.squeeze(cs.namespace(|| format!("poseidon{index}")), 250, false)?;
                    let mut sum = LinearCombination::zero();
                    let mut coeff = F::ONE;
                    for bit in bits { sum = sum + (coeff, bit.get_variable()); coeff = coeff.double(); }
                    cs.enforce(|| format!("poseidon-output{index}"), |_| sum, |lc| lc + CS::one(), |lc| lc + vars[output].get_variable());
                }
            }
        }
        Ok(self.plan.outputs.iter().map(|n| vars[n].clone()).collect())
    }
}

pub struct Parameters {
    pub plan: Arc<Plan>, pp: PP, pk: PK, vk: VK,
    pub plan_hash: String, pub parameter_hash: String, pub setup_ms: f64,
    pub constraints: (usize, usize), pub variables: (usize, usize),
}
impl Parameters {
    pub fn new(program: &Program, binding: &str) -> Result<Self, String> {
        let start = Instant::now();
        let plan = Arc::new(compile(program, binding)?);
        let circuit = IntegerCircuit { plan: plan.clone(), input: vec![0; program.input_count] };
        let pp = PP::setup(&circuit, &*S1::ck_floor(), &*S2::ck_floor()).map_err(|_| "Z4_PARAMETER_SETUP_FAILED")?;
        let (pk, vk) = CompressedSNARK::<E1,E2,IntegerCircuit,S1,S2>::setup(&pp).map_err(|_| "Z4_COMPRESSION_SETUP_FAILED")?;
        let parameter_hash = hash_bytes(&bincode::serde::encode_to_vec((&pp, &vk), bincode::config::legacy()).map_err(|_| "Z4_PARAMETER_ENCODING")?);
        Ok(Self { plan_hash: hash_json(plan.as_ref()), plan, parameter_hash, setup_ms: start.elapsed().as_secs_f64()*1000.0,
                  constraints: pp.num_constraints(), variables: pp.num_variables(), pp, pk, vk })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EncodedProof {
    pub profile: String,
    pub plan_hash: String,
    pub parameter_hash: String,
    pub proof_hex: String,
}
pub fn statement(r: &Request) -> Result<Statement, String> {
    Ok(Statement { profile: PROFILE.into(), backend: BACKEND.into(), compiler: COMPILER.into(),
                   program: r.program.clone(), binding: r.binding.clone(), initial: r.initial.clone(),
                   final_state: execute(r)?, steps: r.inputs.len(), input_commitment: commitment(r)? })
}
fn z_initial(s: &Statement) -> Result<Vec<F>, String> {
    validate_program(&s.program)?;
    let limbs = statement_binding(&s.program, &s.binding)?;
    if s.profile != PROFILE || s.backend != BACKEND || s.compiler != COMPILER { return Err("Z4_SECURITY_PROFILE_IDENTITY".into()); }
    if !LENGTHS.contains(&s.steps) || s.initial.len() != s.program.registers.len() || s.final_state.len() != s.initial.len() {
        return Err("Z4_ACTUAL_LENGTH_OR_STATE_BOUND".into());
    }
    let mut z = s.initial.iter().map(|v| i64_value(v).map(scalar)).collect::<Result<Vec<_>, _>>()?;
    for (i, r) in s.program.registers.iter().enumerate() {
        if r.r#type == "bool" && !["0", "1"].contains(&s.initial[i].as_str()) { return Err("Z4_BOOLEAN_RANGE".into()); }
        i64_value(&s.final_state[i])?;
        if r.r#type == "bool" && !["0", "1"].contains(&s.final_state[i].as_str()) { return Err("Z4_BOOLEAN_RANGE".into()); }
    }
    z.resize(8, F::ZERO); z.push(F::ZERO); z.push(F::ZERO);
    z.extend(limbs.into_iter().map(F::from));
    Ok(z)
}
pub fn prove(r: &Request, params: &Parameters) -> Result<serde_json::Value, String> {
    let s = statement(r)?;
    if hash_json(&compile(&r.program, &r.binding)?) != params.plan_hash { return Err("Z4_RELATION_CHANGED".into()); }
    let z = z_initial(&s)?;
    let first = IntegerCircuit { plan: params.plan.clone(), input: r.inputs[0].iter().map(|v| integer(v).unwrap()).collect() };
    let start = Instant::now();
    let mut recursive = RecursiveSNARK::<E1,E2,IntegerCircuit>::new(&params.pp, &first, &z).map_err(|_| "Z4_PROVER_INITIALIZATION")?;
    for row in &r.inputs {
        let circuit = IntegerCircuit { plan: params.plan.clone(), input: row.iter().map(|v| integer(v).unwrap()).collect() };
        recursive.prove_step(&params.pp, &circuit).map_err(|_| "Z4_PROVE_STEP_FAILED")?;
    }
    let fold_ms = start.elapsed().as_secs_f64()*1000.0;
    let start = Instant::now();
    let proof = Proof::prove(&params.pp, &params.pk, &recursive).map_err(|_| "Z4_COMPRESSION_FAILED")?;
    let bytes = bincode::serde::encode_to_vec(&proof, bincode::config::legacy()).map_err(|_| "Z4_PROOF_ENCODING")?;
    if bytes.len() > MAX_BYTES/2 { return Err("Z4_PROOF_BYTE_BOUND".into()); }
    let artifact = EncodedProof { profile: PROFILE.into(), plan_hash: params.plan_hash.clone(), parameter_hash: params.parameter_hash.clone(), proof_hex: hex::encode(&bytes) };
    Ok(serde_json::json!({"statement":s,"artifact":artifact,"meters":{"foldMs":fold_ms,"compressMs":start.elapsed().as_secs_f64()*1000.0,"setupMs":params.setup_ms,"proofBytes":bytes.len(),"constraints":params.constraints,"variables":params.variables,"usd":null,"humanSeconds":null,"eligibleReuseN":0}}))
}
pub fn verify(s: &Statement, encoded: &EncodedProof, params: &Parameters) -> Result<serde_json::Value, String> {
    let z = z_initial(s)?;
    if encoded.profile != PROFILE { return Err("Z4_SECURITY_PROFILE_IDENTITY".into()); }
    if encoded.plan_hash != params.plan_hash || encoded.plan_hash != hash_json(&compile(&s.program, &s.binding)?) { return Err("Z4_RELATION_CHANGED".into()); }
    if encoded.parameter_hash != params.parameter_hash { return Err("Z4_PARAMETER_IDENTITY".into()); }
    if encoded.proof_hex.len() > MAX_BYTES || encoded.proof_hex.len() % 2 != 0
        || encoded.proof_hex.bytes().any(|b| !b.is_ascii_digit() && !(b'a'..=b'f').contains(&b)) { return Err("Z4_PROOF_ENCODING".into()); }
    let bytes = hex::decode(&encoded.proof_hex).map_err(|_| "Z4_PROOF_ENCODING")?;
    let (proof, used): (Proof, usize) = bincode::serde::decode_from_slice(&bytes, bincode::config::legacy().with_limit::<MAX_BYTES>())
        .map_err(|_| "Z4_PROOF_ENCODING")?;
    if used != bytes.len() { return Err("Z4_PROOF_TRAILING_BYTES".into()); }
    let start = Instant::now();
    let actual = proof.verify(&params.vk, s.steps, &z).map_err(|_| "Z4_CRYPTOGRAPHIC_VERIFIER_REJECTED")?;
    let mut final_z = s.final_state.iter().map(|v| i64_value(v).map(scalar)).collect::<Result<Vec<_>, _>>()?;
    final_z.resize(8, F::ZERO); final_z.push(F::from(s.steps as u64));
    final_z.push(from_hex(&s.input_commitment)?);
    final_z.extend(statement_binding(&s.program, &s.binding)?.into_iter().map(F::from));
    if actual != final_z { return Err("Z4_PUBLIC_OUTPUT_OR_COMMITMENT_MISMATCH".into()); }
    Ok(serde_json::json!({"status":"VERIFIED_COMPUTATION_ONLY","statementDigest":hash_json(s),"planHash":params.plan_hash,"parameterHash":params.parameter_hash,"verifyMs":start.elapsed().as_secs_f64()*1000.0,"proofBytes":bytes.len(),"executionAuthorityGranted":false,"securityAdmission":"NOT_RUN"}))
}
