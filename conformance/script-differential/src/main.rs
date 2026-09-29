// Differential oracle: Bitcoin Core 26.0 libbitcoinconsensus script
// verification of every input of every corpus transaction, with every spent
// output supplied so Taproot inputs are checked under BIP341 and BIP342.
// Script rules are unchanged from 26.0 through v29.0. Locktime finality and
// BIP68 sequence locks are block-context rules this library does not judge;
// CHECKLOCKTIMEVERIFY itself is a script rule and is judged.
use {
  bitcoinconsensus::{Utxo, VERIFY_ALL_PRE_TAPROOT, VERIFY_TAPROOT, verify_with_flags},
  serde_json::{Value, json},
  std::io::Read,
};

fn bytes(hex: &str) -> Vec<u8> {
  (0..hex.len())
    .step_by(2)
    .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
    .collect()
}

fn main() {
  let mut input = String::new();
  std::io::stdin().read_to_string(&mut input).unwrap();
  let cases: Vec<Value> = serde_json::from_str(&input).unwrap();
  let mut out = Vec::new();

  for case in cases {
    let tx = bytes(case["txHex"].as_str().unwrap());
    let prevouts: Vec<(Vec<u8>, u64)> = case["prevouts"]
      .as_array()
      .unwrap()
      .iter()
      .map(|p| (bytes(p["scriptHex"].as_str().unwrap()), p["valueSats"].as_str().unwrap().parse().unwrap()))
      .collect();
    let utxos: Vec<Utxo> = prevouts
      .iter()
      .map(|(script, value)| Utxo {
        script_pubkey: script.as_ptr(),
        script_pubkey_len: script.len() as u32,
        value: *value as i64,
      })
      .collect();
    let verdicts: Vec<String> = prevouts
      .iter()
      .enumerate()
      .map(|(index, (script, value))| {
        match verify_with_flags(script, *value, &tx, Some(&utxos), index, VERIFY_ALL_PRE_TAPROOT | VERIFY_TAPROOT) {
          Ok(()) => "VALID".to_string(),
          Err(error) => format!("{error:?}"),
        }
      })
      .collect();
    out.push(json!(verdicts));
  }
  println!("{}", serde_json::to_string(&out).unwrap());
}
