mod model;
mod plan;
mod proof;

use model::*;
use proof::{EncodedProof, Parameters};
use serde_json::Value;
use std::io::{self, BufRead, Read, Write};

fn run(op: &str, raw: Value, cached: &mut Option<Parameters>) -> Result<Value, String> {
    match op {
        "identity" => Ok(serde_json::json!({"profile":PROFILE,"backend":BACKEND,"compiler":COMPILER,"curveCycle":"Pallas/Vesta","commitment":"Pedersen/IPA both curves","trustedSetup":false,"inputHash":"Nova Poseidon Wide / 250 bits / domain 1513376049","challengeBitsLibrary":128,"hashBitsLibrary":250,"securityExponent":null,"zeroKnowledgeClaim":false})),
        "plan" => {
            let r: Request = serde_json::from_value(raw).map_err(|_| "Z4_REQUEST_SCHEMA")?;
            validate_request(&r)?;
            Ok(serde_json::to_value(plan::compile(&r.program, &r.binding)?).unwrap())
        }
        "commit" => {
            let r: Request = serde_json::from_value(raw).map_err(|_| "Z4_REQUEST_SCHEMA")?;
            Ok(serde_json::json!({"inputCommitment":proof::commitment(&r)?}))
        }
        "interpret" => {
            let r: Request = serde_json::from_value(raw).map_err(|_| "Z4_REQUEST_SCHEMA")?;
            Ok(serde_json::json!({"finalState":execute(&r)?}))
        }
        "prove" => {
            let r: Request = serde_json::from_value(raw).map_err(|_| "Z4_REQUEST_SCHEMA")?;
            execute(&r)?;
            let key = proof::hash_json(&plan::compile(&r.program, &r.binding)?);
            if cached.as_ref().is_none_or(|p| p.plan_hash != key) { *cached = Some(Parameters::new(&r.program, &r.binding)?); }
            proof::prove(&r, cached.as_ref().unwrap())
        }
        "verify" => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Input { statement: Statement, artifact: EncodedProof }
            let input: Input = serde_json::from_value(raw).map_err(|_| "Z4_VERIFIER_SCHEMA")?;
            let key = proof::hash_json(&plan::compile(&input.statement.program, &input.statement.binding)?);
            if cached.as_ref().is_none_or(|p| p.plan_hash != key) { *cached = Some(Parameters::new(&input.statement.program, &input.statement.binding)?); }
            proof::verify(&input.statement, &input.artifact, cached.as_ref().unwrap())
        }
        _ => Err("Z4_PROCESS_OPERATION_UNSUPPORTED".into()),
    }
}
fn response(op: &str, b: &[u8], cached: &mut Option<Parameters>) -> (Value, bool) {
    let result = if b.len() > MAX_BYTES { Err("Z4_PROCESS_INPUT_BOUND".into()) }
        else { serde_json::from_slice(b).map_err(|_| "Z4_PROCESS_JSON".into()).and_then(|v| run(op,v,cached)) };
    match result { Ok(body) => (serde_json::json!({"ok":true,"body":body}), true),
                   Err(code) => (serde_json::json!({"ok":false,"code":code}), false) }
}
fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let op = args.get(1).map(String::as_str).unwrap_or("");
    let mut cached = None;
    if args.get(2).is_some_and(|s| s == "--stream") && args.len() == 3 {
        let mut input = io::stdin().lock();
        loop {
            let mut line = Vec::new();
            match input.by_ref().take((MAX_BYTES+1) as u64).read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let (out, _) = response(op, &line, &mut cached);
                    println!("{out}"); io::stdout().flush().unwrap();
                    if line.len() > MAX_BYTES { std::process::exit(1); }
                }
                Err(_) => std::process::exit(1),
            }
        }
    } else {
        if args.len() != 2 { eprintln!("Z4_PROCESS_ARGUMENTS"); std::process::exit(1); }
        let mut bytes = Vec::new();
        io::stdin().take((MAX_BYTES+1) as u64).read_to_end(&mut bytes).unwrap();
        let (out, ok) = response(op, &bytes, &mut cached);
        println!("{out}");
        if !ok { std::process::exit(1); }
    }
}
