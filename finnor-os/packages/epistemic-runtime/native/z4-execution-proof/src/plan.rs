use crate::model::{statement_binding, validate_program, Operand, Program, COMPILER};
use serde::{Deserialize, Serialize};

pub type Linear = Vec<(String, String)>;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Recipe {
    External { index: usize },
    Input { index: usize },
    Constant { value: String },
    Linear { terms: Linear },
    Product { a: String, b: String },
    Bit { source: String, bit: usize, offset: String },
    Equal { a: String, b: String },
    Inverse { a: String, b: String },
    Select { a: String, b: String, c: String },
    Hash { inputs: Vec<String> },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Wire { pub name: String, pub recipe: Recipe }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Gate {
    R1cs { a: Linear, b: Linear, c: Linear },
    Poseidon250 { inputs: Vec<String>, output: String },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Plan {
    pub compiler: String,
    pub wires: Vec<Wire>,
    pub gates: Vec<Gate>,
    pub outputs: Vec<String>,
}
pub fn term(w: &str, c: i128) -> (String, String) { (w.into(), c.to_string()) }
fn one() -> Linear { vec![term("one", 1)] }
impl Plan {
    fn wire(&mut self, name: String, recipe: Recipe) -> String {
        self.wires.push(Wire { name: name.clone(), recipe }); name
    }
    fn gate(&mut self, a: Linear, b: Linear, c: Linear) { self.gates.push(Gate::R1cs { a, b, c }); }
    fn equal(&mut self, left: Linear, right: Linear) { self.gate(left, one(), right); }
    fn boolean(&mut self, name: &str) {
        self.gate(vec![term(name, 1)], vec![term(name, 1), term("one", -1)], vec![]);
    }
    fn bits(&mut self, name: &str, width: usize, offset: i128) -> Vec<String> {
        let mut packed = Vec::new();
        let mut names = Vec::new();
        for b in 0..width {
            let bit = self.wire(format!("{name}.b{b}"), Recipe::Bit { source: name.into(), bit: b, offset: offset.to_string() });
            self.boolean(&bit); packed.push(term(&bit, 1i128 << b)); names.push(bit);
        }
        let mut left = vec![term(name, 1)];
        if offset != 0 { left.push(term("one", offset)); }
        self.equal(left, packed); names
    }
    fn operand(&mut self, o: &Operand, regs: &[String], instruction: usize, label: &str) -> String {
        match o {
            Operand::Register { reg } => regs[*reg].clone(),
            Operand::Input { input } => format!("x{input}"),
            Operand::Constant { r#const } => {
                let n = format!("i{instruction}.{label}");
                self.wire(n.clone(), Recipe::Constant { value: r#const.clone() });
                self.equal(vec![term(&n, 1)], vec![term("one", r#const.parse().unwrap())]); n
            }
        }
    }
}
pub fn compile(p: &Program, binding: &str) -> Result<Plan, String> {
    validate_program(p)?;
    let limbs = statement_binding(p, binding)?;
    let mut plan = Plan { compiler: COMPILER.into(), wires: vec![], gates: vec![], outputs: vec![] };
    // Eight register slots are retained for a fixed, unambiguous state encoding.
    for i in 0..14 { plan.wire(format!("z{i}"), Recipe::External { index: i }); }
    for i in 0..8 {
        if i >= p.registers.len() { plan.equal(vec![term(&format!("z{i}"), 1)], vec![]); }
        plan.bits(&format!("z{i}"), 64, 1i128 << 63);
        if p.registers.get(i).is_some_and(|r| r.r#type == "bool") { plan.boolean(&format!("z{i}")); }
    }
    plan.bits("z8", 9, 0);
    for (i, limb) in limbs.iter().enumerate() {
        plan.equal(vec![term(&format!("z{}", i+10), 1)], vec![term("one", *limb as i128)]);
    }
    for i in 0..p.input_count {
        plan.wire(format!("x{i}"), Recipe::Input { index: i });
        plan.bits(&format!("x{i}"), 32, 1i128 << 31);
    }
    let mut regs = (0..8).map(|i| format!("z{i}")).collect::<Vec<_>>();
    for (index, i) in p.instructions.iter().enumerate() {
        let a = plan.operand(&i.a, &regs, index, "a");
        let b = plan.operand(&i.b, &regs, index, "b");
        let out = format!("i{index}.out");
        match i.op.as_str() {
            "add" | "sub" => {
                let terms = vec![term(&a, 1), term(&b, if i.op == "add" { 1 } else { -1 })];
                plan.wire(out.clone(), Recipe::Linear { terms: terms.clone() });
                plan.equal(terms, vec![term(&out, 1)]);
            }
            "mul" => {
                plan.wire(out.clone(), Recipe::Product { a: a.clone(), b: b.clone() });
                plan.gate(vec![term(&a, 1)], vec![term(&b, 1)], vec![term(&out, 1)]);
            }
            "lt" => {
                let difference = format!("i{index}.difference");
                let terms = vec![term(&a, 1), term(&b, -1), term("one", 1i128 << 64)];
                plan.wire(difference.clone(), Recipe::Linear { terms: terms.clone() });
                plan.equal(terms, vec![term(&difference, 1)]);
                let bits = plan.bits(&difference, 65, 0);
                let terms = vec![term("one", 1), term(&bits[64], -1)];
                plan.wire(out.clone(), Recipe::Linear { terms: terms.clone() });
                plan.equal(terms, vec![term(&out, 1)]);
            }
            "eq" => {
                plan.wire(out.clone(), Recipe::Equal { a: a.clone(), b: b.clone() });
                let inverse = plan.wire(format!("i{index}.inverse"), Recipe::Inverse { a: a.clone(), b: b.clone() });
                plan.gate(vec![term(&a, 1), term(&b, -1)], vec![term(&inverse, 1)], vec![term("one", 1), term(&out, -1)]);
                plan.gate(vec![term(&a, 1), term(&b, -1)], vec![term(&out, 1)], vec![]);
            }
            "select" => {
                let c = plan.operand(i.c.as_ref().unwrap(), &regs, index, "c");
                plan.wire(out.clone(), Recipe::Select { a: a.clone(), b: b.clone(), c: c.clone() });
                plan.boolean(&c);
                plan.gate(vec![term(&a, 1), term(&b, -1)], vec![term(&c, 1)], vec![term(&out, 1), term(&b, -1)]);
            }
            _ => return Err("Z4_UNSUPPORTED_OPCODE".into()),
        }
        if p.registers[i.dst].r#type == "bool" { plan.boolean(&out); }
        else { plan.bits(&out, 64, 1i128 << 63); }
        regs[i.dst] = out;
    }
    let terms = vec![term("z8", 1), term("one", 1)];
    plan.wire("counter".into(), Recipe::Linear { terms: terms.clone() });
    plan.equal(terms, vec![term("counter", 1)]);
    plan.bits("counter", 9, 0);
    plan.wire("domain".into(), Recipe::Constant { value: "1513376049".into() });
    plan.equal(vec![term("domain", 1)], vec![term("one", 1513376049)]);
    let inputs = ["domain", "z8", "z9"].iter().map(|s| s.to_string())
        .chain((0..p.input_count).map(|i| format!("x{i}"))).collect::<Vec<_>>();
    plan.wire("accumulator".into(), Recipe::Hash { inputs: inputs.clone() });
    plan.gates.push(Gate::Poseidon250 { inputs, output: "accumulator".into() });
    plan.outputs = regs.into_iter().chain(["counter".into(), "accumulator".into()])
        .chain((10..14).map(|i| format!("z{i}"))).collect();
    Ok(plan)
}
