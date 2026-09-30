// Differential oracle: rust-bitcoin 0.32.5 SighashCache signature hashes for
// every input of every corpus case, under every sighash flag, for the legacy,
// BIP143 and BIP341 (key and script path, with and without annex) algorithms.
// Hashes are printed in natural byte order, as the verifier returns them.
use {
  bitcoin::{
    Amount, ScriptBuf, TapLeafHash, Transaction, TxOut,
    consensus::encode::deserialize,
    hashes::Hash,
    sighash::{Annex, EcdsaSighashType, Prevouts, SighashCache, TapSighashType},
  },
  serde_json::{Value, json},
  std::io::Read,
};

fn bytes(hex: &str) -> Vec<u8> {
  (0..hex.len())
    .step_by(2)
    .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
    .collect()
}

fn to_hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const ECDSA_TYPES: [u32; 6] = [0x01, 0x02, 0x03, 0x81, 0x82, 0x83];
const TAP_TYPES: [u8; 7] = [0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83];

fn main() {
  let mut input = String::new();
  std::io::stdin().read_to_string(&mut input).unwrap();
  let cases: Vec<Value> = serde_json::from_str(&input).unwrap();
  let mut out = Vec::new();

  for case in cases {
    let tx: Transaction = deserialize(&bytes(case["txHex"].as_str().unwrap())).unwrap();
    let prevouts: Vec<TxOut> = case["prevouts"]
      .as_array()
      .unwrap()
      .iter()
      .map(|p| TxOut {
        value: Amount::from_sat(p["valueSats"].as_str().unwrap().parse().unwrap()),
        script_pubkey: ScriptBuf::from_bytes(bytes(p["scriptHex"].as_str().unwrap())),
      })
      .collect();
    let annex_bytes = case.get("annexHex").and_then(|a| a.as_str()).map(bytes);
    let leaf = case
      .get("leafHashHex")
      .and_then(|l| l.as_str())
      .map(|l| TapLeafHash::from_slice(&bytes(l)).unwrap());

    let mut inputs = Vec::new();
    for index in 0..tx.input.len() {
      let cache = SighashCache::new(&tx);
      let mut legacy = serde_json::Map::new();
      let mut segwit = serde_json::Map::new();
      for t in ECDSA_TYPES {
        let hash = cache.legacy_signature_hash(index, &prevouts[index].script_pubkey, t).unwrap();
        legacy.insert(t.to_string(), json!(to_hex(hash.as_byte_array())));
        let mut cache = SighashCache::new(&tx);
        let ty = EcdsaSighashType::from_standard(t).unwrap();
        let script = &prevouts[index].script_pubkey;
        let hash = if script.is_p2wpkh() {
          cache.p2wpkh_signature_hash(index, script, prevouts[index].value, ty).unwrap().to_byte_array()
        } else {
          cache.p2wsh_signature_hash(index, script, prevouts[index].value, ty).unwrap().to_byte_array()
        };
        segwit.insert(t.to_string(), json!(to_hex(&hash)));
      }
      let mut key = serde_json::Map::new();
      let mut script_path = serde_json::Map::new();
      for t in TAP_TYPES {
        let ty = TapSighashType::from_consensus_u8(t).unwrap();
        let mut cache = SighashCache::new(&tx);
        let annex = annex_bytes.as_ref().map(|a| Annex::new(a).unwrap());
        let hash = cache
          .taproot_signature_hash(index, &Prevouts::All(&prevouts), annex.clone(), None, ty)
          .ok()
          .map(|h| to_hex(h.as_byte_array()));
        key.insert(t.to_string(), json!(hash));
        if let Some(leaf) = leaf {
          let hash = cache
            .taproot_signature_hash(index, &Prevouts::All(&prevouts), annex, Some((leaf, 0xffffffff)), ty)
            .ok()
            .map(|h| to_hex(h.as_byte_array()));
          script_path.insert(t.to_string(), json!(hash));
        }
      }
      inputs.push(json!({ "legacy": legacy, "segwit": segwit, "taprootKey": key, "taprootScript": script_path }));
    }
    out.push(json!({ "inputs": inputs }));
  }
  println!("{}", serde_json::to_string(&out).unwrap());
}
