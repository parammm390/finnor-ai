//! Explicitly inadmissible relation used only for the predeclared falsifier.
//! A real valid field proof does not establish checked signed64 arithmetic.
use ff::Field;
use nova_snark::{
 frontend::{num::AllocatedNum,ConstraintSystem,SynthesisError},
 nova::{CompressedSNARK,PublicParams,RecursiveSNARK},
 provider::{PallasEngine,VestaEngine},
 traits::{circuit::StepCircuit,snark::RelaxedR1CSSNARKTrait,Engine},
};
use serde::{Deserialize,Serialize};
use std::io::{self,Read};
type E1=PallasEngine;type E2=VestaEngine;type F=<E1 as Engine>::Scalar;
type S1=nova_snark::spartan::snark::RelaxedR1CSSNARK<E1,nova_snark::provider::ipa_pc::EvaluationEngine<E1>>;
type S2=nova_snark::spartan::snark::RelaxedR1CSSNARK<E2,nova_snark::provider::ipa_pc::EvaluationEngine<E2>>;
type Proof=CompressedSNARK<E1,E2,FieldOnly,S1,S2>;
#[derive(Clone)]
struct FieldOnly;
impl StepCircuit<F> for FieldOnly {
 fn arity(&self)->usize{14}
 fn synthesize<CS:ConstraintSystem<F>>(&self,cs:&mut CS,z:&[AllocatedNum<F>])->Result<Vec<AllocatedNum<F>>,SynthesisError>{
  let out=AllocatedNum::alloc(cs.namespace(||"field-out"),||z[0].get_value().map(|x|x+F::ONE).ok_or(SynthesisError::AssignmentMissing))?;
  cs.enforce(||"field-addition-without-range",|lc|lc+z[0].get_variable()+CS::one(),|lc|lc+CS::one(),|lc|lc+out.get_variable());
  let mut result=z.to_vec();result[0]=out;Ok(result)
 }
}
#[derive(Serialize,Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
struct Artifact{profile:String,proof_hex:String}
fn run(raw:serde_json::Value)->Result<serde_json::Value,String>{
 let operation=raw.get("operation").and_then(|x|x.as_str()).ok_or("FIELD_OPERATION")?;
 let circuit=FieldOnly;
 let pp=PublicParams::<E1,E2,FieldOnly>::setup(&circuit,&*S1::ck_floor(),&*S2::ck_floor()).map_err(|_|"FIELD_SETUP")?;
 let (pk,vk)=Proof::setup(&pp).map_err(|_|"FIELD_COMPRESSION_SETUP")?;
 let mut z=vec![F::ZERO;14];z[0]=F::from(i64::MAX as u64);
 if operation=="prove"{
  let mut recursive=RecursiveSNARK::<E1,E2,FieldOnly>::new(&pp,&circuit,&z).map_err(|_|"FIELD_INITIALIZATION")?;
  recursive.prove_step(&pp,&circuit).map_err(|_|"FIELD_PROVE")?;
  let proof=Proof::prove(&pp,&pk,&recursive).map_err(|_|"FIELD_COMPRESS")?;
  let bytes=bincode::serde::encode_to_vec(&proof,bincode::config::legacy()).map_err(|_|"FIELD_ENCODE")?;
  return Ok(serde_json::to_value(Artifact{profile:"ADVERSARIAL_FIELD_ONLY_NOT_Z4".into(),proof_hex:hex::encode(bytes)}).unwrap());
 }
 if operation!="verify"{return Err("FIELD_OPERATION".into());}
 let a:Artifact=serde_json::from_value(raw.get("artifact").cloned().ok_or("FIELD_ARTIFACT")?).map_err(|_|"FIELD_ARTIFACT")?;
 if a.profile!="ADVERSARIAL_FIELD_ONLY_NOT_Z4"||a.proof_hex.len()>1024*1024{return Err("FIELD_ARTIFACT".into());}
 let b=hex::decode(a.proof_hex).map_err(|_|"FIELD_ENCODING")?;
 let (proof,used):(Proof,usize)=bincode::serde::decode_from_slice(&b,bincode::config::legacy().with_limit::<1048576>()).map_err(|_|"FIELD_ENCODING")?;
 if used!=b.len(){return Err("FIELD_TRAILING_BYTES".into());}
 let actual=proof.verify(&vk,1,&z).map_err(|_|"FIELD_CRYPTOGRAPHIC_REJECTION")?;
 let mut expected=z;expected[0]+=F::ONE;
 if actual!=expected{return Err("FIELD_PUBLIC_OUTPUT".into());}
 Ok(serde_json::json!({"status":"VALID_FIELD_PROOF_NOT_SIGNED_INTEGER_PROOF","initial":"9223372036854775807",
  "fieldOutput":"9223372036854775808","signed64Execution":"OVERFLOW_REJECT_REQUIRED","zeroKnowledgeClaim":false,"executionAuthorityGranted":false}))
}
fn main(){
 let mut bytes=Vec::new();io::stdin().take(1048577).read_to_end(&mut bytes).unwrap();
 let result=if bytes.len()>1048576{Err("FIELD_BYTE_BOUND".into())}else{
  serde_json::from_slice(&bytes).map_err(|_|"FIELD_JSON".to_string()).and_then(run)};
 match result{
  Ok(body)=>println!("{}",serde_json::json!({"ok":true,"body":body})),
  Err(code)=>{println!("{}",serde_json::json!({"ok":false,"code":code}));std::process::exit(1);}
 }
}
