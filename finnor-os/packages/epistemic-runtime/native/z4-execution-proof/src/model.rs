use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PROFILE: &str = "Z4_I32_I64_PALLAS_VESTA_IPA_V1";
pub const BACKEND: &str = "nova-01b1e2d662a847ed7029770ecbaf6687398899dd-0.76.0";
pub const COMPILER: &str = "z4-r1cs-integer-v2";
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const LENGTHS: [usize; 7] = [1, 2, 4, 8, 16, 64, 256];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Operand {
    Register { reg: usize },
    Input { input: usize },
    Constant { r#const: String },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Register {
    pub r#type: String,
    pub unit: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Instruction {
    pub op: String,
    pub dst: usize,
    pub a: Operand,
    pub b: Operand,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub c: Option<Operand>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Program {
    pub schema: String,
    pub input_count: usize,
    pub registers: Vec<Register>,
    pub input_units: Vec<String>,
    pub rounding: String,
    pub instructions: Vec<Instruction>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub program: Program,
    pub initial: Vec<String>,
    pub inputs: Vec<Vec<String>>,
    pub binding: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Statement {
    pub profile: String,
    pub backend: String,
    pub compiler: String,
    pub program: Program,
    pub binding: String,
    pub initial: Vec<String>,
    pub final_state: Vec<String>,
    pub steps: usize,
    pub input_commitment: String,
}
pub fn integer(s: &str) -> Result<i128, String> {
    if s.is_empty() || s.len() > 21 || s == "-0" || s.starts_with('+')
        || s.starts_with('0') && s.len() > 1 || s.starts_with("-0") {
        return Err("Z4_CANONICAL_INTEGER".into());
    }
    let n = s.parse::<i128>().map_err(|_| "Z4_CANONICAL_INTEGER")?;
    if n.to_string() != s { return Err("Z4_CANONICAL_INTEGER".into()); }
    Ok(n)
}
pub fn i64_value(s: &str) -> Result<i128, String> {
    let n = integer(s)?;
    if !(i64::MIN as i128..=i64::MAX as i128).contains(&n) {
        return Err("Z4_SIGNED64_RANGE".into());
    }
    Ok(n)
}
fn unit<'a>(p: &'a Program, o: &Operand) -> Result<&'a str, String> {
    match o {
        Operand::Register { reg } => p.registers.get(*reg).map(|x| x.unit.as_str()).ok_or("Z4_REGISTER_BOUND".into()),
        Operand::Input { input } => p.input_units.get(*input).map(String::as_str).ok_or("Z4_INPUT_BOUND".into()),
        Operand::Constant { r#const } => { i64_value(r#const)?; Ok("1") }
    }
}
pub fn validate_program(p: &Program) -> Result<(), String> {
    if p.schema != "finnor.z4.integer-program.v1" || p.rounding != "EXACT_NO_CONVERSION"
        || !(1..=8).contains(&p.registers.len()) || !(1..=8).contains(&p.input_count)
        || p.input_units.len() != p.input_count || !(1..=16).contains(&p.instructions.len()) {
        return Err("Z4_UNSUPPORTED_PROGRAM_DOMAIN".into());
    }
    for r in &p.registers {
        if !["i64", "bool"].contains(&r.r#type.as_str()) || !valid_unit(&r.unit)
            || r.r#type == "bool" && r.unit != "1" { return Err("Z4_REGISTER_TYPE_OR_UNIT".into()); }
    }
    if p.input_units.iter().any(|u| !valid_unit(u)) { return Err("Z4_UNIT_ENCODING".into()); }
    for i in &p.instructions {
        let dst = p.registers.get(i.dst).ok_or("Z4_REGISTER_BOUND")?;
        let a = unit(p, &i.a)?;
        let b = unit(p, &i.b)?;
        let predicate = matches!(i.op.as_str(), "lt" | "eq");
        if predicate != (dst.r#type == "bool") { return Err("Z4_RESULT_TYPE".into()); }
        match i.op.as_str() {
            "add" | "sub" | "lt" | "eq" | "select" => {
                if a != b || !predicate && dst.unit != a { return Err("Z4_UNIT_MISMATCH".into()); }
            }
            "mul" => {
                if a != "1" && b != "1" || dst.unit != if a == "1" { b } else { a } {
                    return Err("Z4_UNSUPPORTED_SCALE_CONVERSION".into());
                }
            }
            _ => return Err("Z4_UNSUPPORTED_OPCODE".into()),
        }
        if i.op == "select" {
            match &i.c {
                Some(Operand::Register { reg }) if p.registers.get(*reg).is_some_and(|r| r.r#type == "bool") => (),
                _ => return Err("Z4_BOOLEAN_SELECT_REQUIRED".into()),
            }
        } else if i.c.is_some() { return Err("Z4_UNUSED_OPERAND".into()); }
    }
    Ok(())
}
fn valid_unit(u: &str) -> bool {
    !u.is_empty() && u.len() <= 64 && u.bytes().all(|c| c.is_ascii_alphanumeric() || b"_:/.-".contains(&c))
}
pub fn binding_limbs(b: &str) -> Result<Vec<u64>, String> {
    if b.len() != 64 || !b.bytes().all(|x| x.is_ascii_digit() || (b'a'..=b'f').contains(&x)) {
        return Err("Z4_BINDING_DIGEST".into());
    }
    let raw = hex::decode(b).map_err(|_| "Z4_BINDING_DIGEST")?;
    Ok(raw.chunks_exact(8).map(|x| u64::from_be_bytes(x.try_into().unwrap())).collect())
}
/** Numeric constraint shapes alone do not bind unused type/unit metadata.
 * All public runtime semantics and the caller's context enter the proved state. */
pub fn statement_binding(p: &Program, binding: &str) -> Result<Vec<u64>, String> {
    binding_limbs(binding)?;
    let value = serde_json::json!({"domain":"finnor.z4.semantic-state-binding.v1",
        "profile":PROFILE,"backend":BACKEND,"compiler":COMPILER,"program":p,"binding":binding});
    let bytes = serde_json::to_vec(&value).map_err(|_| "Z4_SEMANTIC_BINDING_ENCODING")?;
    binding_limbs(&hex::encode(Sha256::digest(bytes)))
}
pub fn validate_request(r: &Request) -> Result<Vec<i128>, String> {
    validate_program(&r.program)?;
    binding_limbs(&r.binding)?;
    if !LENGTHS.contains(&r.inputs.len()) || r.initial.len() != r.program.registers.len() {
        return Err("Z4_ACTUAL_LENGTH_OR_STATE_BOUND".into());
    }
    let initial = r.initial.iter().map(|v| i64_value(v)).collect::<Result<Vec<_>, _>>()?;
    for (v, reg) in initial.iter().zip(&r.program.registers) {
        if reg.r#type == "bool" && ![0, 1].contains(v) { return Err("Z4_BOOLEAN_RANGE".into()); }
    }
    for row in &r.inputs {
        if row.len() != r.program.input_count { return Err("Z4_INPUT_ARITY".into()); }
        for v in row {
            if !(i32::MIN as i128..=i32::MAX as i128).contains(&integer(v)?) { return Err("Z4_SIGNED32_RANGE".into()); }
        }
    }
    Ok(initial)
}
fn value(o: &Operand, s: &[i128], x: &[i128]) -> i128 {
    match o {
        Operand::Register { reg } => s[*reg],
        Operand::Input { input } => x[*input],
        Operand::Constant { r#const } => r#const.parse().unwrap(),
    }
}
pub fn execute(r: &Request) -> Result<Vec<String>, String> {
    let mut s = validate_request(r)?;
    for row in &r.inputs {
        let x = row.iter().map(|v| integer(v)).collect::<Result<Vec<_>, _>>()?;
        for i in &r.program.instructions {
            let a = value(&i.a, &s, &x);
            let b = value(&i.b, &s, &x);
            let z = match i.op.as_str() {
                "add" => a + b, "sub" => a - b, "mul" => a * b,
                "lt" => i128::from(a < b), "eq" => i128::from(a == b),
                "select" => if value(i.c.as_ref().unwrap(), &s, &x) == 1 { a } else { b },
                _ => return Err("Z4_UNSUPPORTED_OPCODE".into()),
            };
            if !(i64::MIN as i128..=i64::MAX as i128).contains(&z) { return Err("Z4_SIGNED64_OVERFLOW".into()); }
            s[i.dst] = z;
        }
    }
    Ok(s.iter().map(ToString::to_string).collect())
}
