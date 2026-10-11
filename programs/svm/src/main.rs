//! One LiteSVM instance behind a line protocol: each stdin line is a JSON request `{"op": ..}`,
//! each stdout line the reply `{"result": ..}` or `{"error": ".."}`, in order. Addresses, hashes,
//! account data and transactions are hex; lamports are decimal strings.
//!
//! Transactions are signed wire bytes and run with signature and blockhash checks on (the
//! `LiteSVM::new()` defaults). `set` writes accounts directly, for state loaded from mainnet.

use std::io::{self, BufRead, Write};

use litesvm::LiteSVM;
use serde_json::{json, Value};
use solana_account::Account;
use solana_address::Address;
use solana_instruction_error::InstructionError;
use solana_rent::Rent;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 { return Err("odd hex length".into()); }
    (0..text.len()).step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|e| format!("bad hex: {e}")))
        .collect()
}

fn text<'a>(req: &'a Value, key: &str) -> Result<&'a str, String> {
    req[key].as_str().ok_or_else(|| format!("missing {key}"))
}

fn address(req: &Value, key: &str) -> Result<Address, String> {
    let bytes = unhex(text(req, key)?)?;
    let array: [u8; 32] = bytes.try_into().map_err(|_| format!("{key} is not 32 bytes"))?;
    Ok(Address::new_from_array(array))
}

fn lamports(req: &Value, key: &str) -> Result<u64, String> {
    text(req, key)?.parse().map_err(|e| format!("bad {key}: {e}"))
}

fn handle(svm: &mut LiteSVM, req: &Value) -> Result<Value, String> {
    match text(req, "op")? {
        "reset" => {
            *svm = LiteSVM::new();
            Ok(Value::Null)
        }
        "program" => {
            let bytes = std::fs::read(text(req, "path")?).map_err(|e| e.to_string())?;
            svm.add_program(address(req, "id")?, &bytes).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "set" => {
            let account = Account {
                lamports: lamports(req, "lamports")?,
                data: unhex(text(req, "data")?)?,
                owner: address(req, "owner")?,
                executable: req["executable"].as_bool().unwrap_or(false),
                rent_epoch: u64::MAX,
            };
            svm.set_account(address(req, "address")?, account).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "get" => Ok(match svm.get_account(&address(req, "address")?) {
            Some(a) if a.lamports > 0 => json!({
                "lamports": a.lamports.to_string(),
                "owner": hex(a.owner.as_ref()),
                "executable": a.executable,
                "data": hex(&a.data),
            }),
            _ => Value::Null,
        }),
        "blockhash" => Ok(json!(hex(svm.latest_blockhash().as_ref()))),
        "rent" => {
            let len = req["len"].as_u64().ok_or("missing len")? as usize;
            Ok(json!(svm.minimum_balance_for_rent_exemption(len).to_string()))
        }
        // Rescales the Rent sysvar so that the minimum balance of an empty account is `min0`,
        // the figure a cluster answers to getMinimumBalanceForRentExemption(0).
        "rent_floor" => {
            let min0 = lamports(req, "min0")?;
            #[allow(deprecated)]
            {
                let mut rent: Rent = svm.get_sysvar::<Rent>();
                let current = rent.minimum_balance(0);
                rent.lamports_per_byte = rent.lamports_per_byte * min0 / current;
                if rent.minimum_balance(0) != min0 {
                    return Err(format!("cannot express {min0} at this rent threshold"));
                }
                svm.set_sysvar(&rent);
            }
            Ok(json!(svm.minimum_balance_for_rent_exemption(0).to_string()))
        }
        "airdrop" => {
            svm.airdrop(&address(req, "address")?, lamports(req, "lamports")?)
                .map_err(|e| format!("{:?}", e.err))?;
            Ok(Value::Null)
        }
        "send" => {
            let bytes = unhex(text(req, "tx")?)?;
            let tx: VersionedTransaction = wincode::deserialize(&bytes).map_err(|e| e.to_string())?;
            let outcome = svm.send_transaction(tx);
            // A fresh blockhash per transaction, so a repeated instruction is a new transaction.
            svm.expire_blockhash();
            Ok(match outcome {
                Ok(meta) => json!({
                    "ok": true,
                    "logs": meta.logs,
                    "units": meta.compute_units_consumed,
                    "fee": meta.fee.to_string(),
                }),
                Err(failed) => {
                    let custom = match &failed.err {
                        TransactionError::InstructionError(index, InstructionError::Custom(code)) =>
                            json!({ "index": index, "code": code }),
                        _ => Value::Null,
                    };
                    json!({
                        "ok": false,
                        "err": format!("{:?}", failed.err),
                        "custom": custom,
                        "logs": failed.meta.logs,
                        "units": failed.meta.compute_units_consumed,
                    })
                }
            })
        }
        other => Err(format!("unknown op {other}")),
    }
}

fn main() {
    let mut svm = LiteSVM::new();
    let mut out = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(req) => match handle(&mut svm, &req) {
                Ok(result) => json!({ "result": result }),
                Err(error) => json!({ "error": error }),
            },
            Err(e) => json!({ "error": format!("bad request: {e}") }),
        };
        if writeln!(out, "{reply}").and_then(|()| out.flush()).is_err() { break; }
    }
}
