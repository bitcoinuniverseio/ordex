// Differential harness: runs the pinned ord 0.29.0 `ordinals` crate
// (commit 7e37a3bd3391044b39f5f11f20dfdb8b3764cd0e) Runestone::decipher on each
// case, and the allocation loop transcribed line for line from
// src/index/updater/rune_updater.rs index_runes (blob bce2ae16) over supplied
// input balances. Etched-rune bookkeeping (index state) is out of scope: the
// etched rune is treated as absent, as it is for every pre-existing input rune.
use {
  bitcoin::{
    Amount, ScriptBuf, Transaction, TxOut, absolute::LockTime, transaction::Version,
  },
  ordinals::{Artifact, Edict, RuneId, Runestone},
  serde_json::{Value, json},
  std::{collections::HashMap, io::Read},
};

fn hex_to_bytes(hex: &str) -> Vec<u8> {
  (0..hex.len())
    .step_by(2)
    .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
    .collect()
}

fn id_str(id: RuneId) -> String {
  format!("{}:{}", id.block, id.tx)
}

fn artifact_json(artifact: &Option<Artifact>) -> Value {
  match artifact {
    None => json!({ "kind": "NONE" }),
    Some(Artifact::Cenotaph(c)) => json!({
      "kind": "CENOTAPH",
      "flaw": c.flaw.map(|f| format!("{f:?}")),
      "mint": c.mint.map(id_str),
      "etching": c.etching.map(|r| r.0.to_string()),
    }),
    Some(Artifact::Runestone(r)) => json!({
      "kind": "RUNESTONE",
      "edicts": r.edicts.iter().map(|e| json!({
        "id": id_str(e.id), "amount": e.amount.to_string(), "output": e.output
      })).collect::<Vec<_>>(),
      "pointer": r.pointer,
      "mint": r.mint.map(id_str),
      "etching": r.etching.map(|e| json!({
        "divisibility": e.divisibility,
        "premine": e.premine.map(|v| v.to_string()),
        "rune": e.rune.map(|v| v.0.to_string()),
        "spacers": e.spacers,
        "symbol": e.symbol.map(|c| c.to_string()),
        "terms": e.terms.map(|t| json!({
          "cap": t.cap.map(|v| v.to_string()),
          "heightStart": t.height.0.map(|v| v.to_string()),
          "heightEnd": t.height.1.map(|v| v.to_string()),
          "amount": t.amount.map(|v| v.to_string()),
          "offsetStart": t.offset.0.map(|v| v.to_string()),
          "offsetEnd": t.offset.1.map(|v| v.to_string()),
        })),
        "turbo": e.turbo,
      })),
    }),
  }
}

fn main() {
  let mut input = String::new();
  std::io::stdin().read_to_string(&mut input).unwrap();
  let cases: Vec<Value> = serde_json::from_str(&input).unwrap();
  let mut out = Vec::new();

  for case in cases {
    let tx = Transaction {
      version: Version(2),
      lock_time: LockTime::ZERO,
      input: Vec::new(),
      output: case["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| TxOut {
          value: Amount::from_sat(0),
          script_pubkey: ScriptBuf::from_bytes(hex_to_bytes(h.as_str().unwrap())),
        })
        .collect(),
    };

    let artifact = Runestone::decipher(&tx);
    let mut result = json!({ "artifact": artifact_json(&artifact) });

    if let Some(balances) = case.get("balances").and_then(|b| b.as_array()) {
      // unallocated = sum of input balances
      let mut unallocated: HashMap<RuneId, u128> = HashMap::new();
      for entry in balances {
        let id: RuneId = entry[0].as_str().unwrap().parse().unwrap();
        let amount: u128 = entry[1].as_str().unwrap().parse().unwrap();
        *unallocated.entry(id).or_default() += amount;
      }

      let mut allocated: Vec<HashMap<RuneId, u128>> = vec![HashMap::new(); tx.output.len()];

      if let Some(artifact) = &artifact {
        if let Some(id) = artifact.mint() {
          if let Some(amount) = case.get("mint").and_then(|m| m.as_str()) {
            *unallocated.entry(id).or_default() += amount.parse::<u128>().unwrap();
          }
        }

        let etched: Option<(RuneId, ())> = None;

        if let Artifact::Runestone(runestone) = artifact {
          for Edict { id, amount, output } in runestone.edicts.iter().copied() {
            let output = usize::try_from(output).unwrap();
            assert!(output <= tx.output.len());

            let id = if id == RuneId::default() {
              let Some((id, ..)) = etched else {
                continue;
              };
              id
            } else {
              id
            };

            let Some(balance) = unallocated.get_mut(&id) else {
              continue;
            };

            let mut allocate = |balance: &mut u128, amount: u128, output: usize| {
              if amount > 0 {
                *balance -= amount;
                *allocated[output].entry(id).or_default() += amount;
              }
            };

            if output == tx.output.len() {
              let destinations = tx
                .output
                .iter()
                .enumerate()
                .filter_map(|(output, tx_out)| (!tx_out.script_pubkey.is_op_return()).then_some(output))
                .collect::<Vec<usize>>();

              if !destinations.is_empty() {
                if amount == 0 {
                  let amount = *balance / destinations.len() as u128;
                  let remainder = usize::try_from(*balance % destinations.len() as u128).unwrap();
                  for (i, output) in destinations.iter().enumerate() {
                    allocate(balance, if i < remainder { amount + 1 } else { amount }, *output);
                  }
                } else {
                  for output in destinations {
                    allocate(balance, amount.min(*balance), output);
                  }
                }
              }
            } else {
              let amount = if amount == 0 { *balance } else { amount.min(*balance) };
              allocate(balance, amount, output);
            }
          }
        }
      }

      let mut burned: HashMap<RuneId, u128> = HashMap::new();

      if let Some(Artifact::Cenotaph(_)) = artifact {
        for (id, balance) in unallocated {
          *burned.entry(id).or_default() += balance;
        }
      } else {
        let pointer = artifact
          .as_ref()
          .map(|artifact| match artifact {
            Artifact::Runestone(runestone) => runestone.pointer,
            Artifact::Cenotaph(_) => unreachable!(),
          })
          .unwrap_or_default();

        if let Some(vout) = pointer
          .map(|pointer| usize::try_from(pointer).unwrap())
          .inspect(|&pointer| assert!(pointer < allocated.len()))
          .or_else(|| {
            tx.output
              .iter()
              .enumerate()
              .find(|(_vout, tx_out)| !tx_out.script_pubkey.is_op_return())
              .map(|(vout, _tx_out)| vout)
          })
        {
          for (id, balance) in unallocated {
            if balance > 0 {
              *allocated[vout].entry(id).or_default() += balance;
            }
          }
        } else {
          for (id, balance) in unallocated {
            if balance > 0 {
              *burned.entry(id).or_default() += balance;
            }
          }
        }
      }

      let mut allocations = Vec::new();
      for (vout, balances) in allocated.into_iter().enumerate() {
        if balances.is_empty() {
          continue;
        }
        if tx.output[vout].script_pubkey.is_op_return() {
          for (id, balance) in &balances {
            *burned.entry(*id).or_default() += *balance;
          }
          continue;
        }
        let mut balances = balances.into_iter().collect::<Vec<(RuneId, u128)>>();
        balances.sort();
        for (id, balance) in balances {
          allocations.push(json!({ "output": vout, "runeId": id_str(id), "amount": balance.to_string() }));
        }
      }
      let mut burned = burned.into_iter().filter(|(_, v)| *v > 0).collect::<Vec<_>>();
      burned.sort();
      result["allocations"] = json!(allocations);
      result["burned"] = json!(burned
        .into_iter()
        .map(|(id, v)| json!({ "runeId": id_str(id), "amount": v.to_string() }))
        .collect::<Vec<_>>());
    }

    out.push(result);
  }

  println!("{}", serde_json::to_string(&out).unwrap());
}
