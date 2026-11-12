//! Deliberately synthetic service ABI. Never deploy this as a production service.
use near_sdk::serde_json::{self, Value, json};
use near_sdk::{Gas, GasWeight, env, near};

#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Record {
    index: u64,
    args: String,
    deposit: String,
    predecessor: String,
    prepaid_gas: String,
    yield_id: [u8; 32],
}
#[near(contract_state)]
#[derive(Default)]
pub struct Services {
    records: Vec<Record>,
    mpc_args: Option<String>,
    mpc_failure: bool,
    fail: Vec<bool>,
    outputs: Vec<String>,
}
#[near]
impl Services {
    pub fn set_mpc_failure(&mut self, fail: bool) {
        self.mpc_failure = fail;
    }
    pub fn derived_public_key(&mut self) -> String {
        assert!(!self.mpc_failure, "controlled MPC failure");
        self.mpc_args = Some(String::from_utf8(env::input().unwrap()).unwrap());
        let xy = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
        let bytes = (0..xy.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&xy[i..i + 2], 16).unwrap())
            .collect();
        String::from(
            &near_sdk::PublicKey::from_parts(near_sdk::CurveType::SECP256K1, bytes).unwrap(),
        )
    }
    #[payable]
    pub fn request_execution(&mut self) {
        let index = self.records.len() as u64;
        let promise = env::promise_yield_create(
            "on_result",
            serde_json::to_vec(&json!({"index":index})).unwrap(),
            Gas::from_tgas(25),
            GasWeight(0),
            0,
        );
        let yield_id = env::read_register(0).unwrap().try_into().unwrap();
        self.records.push(Record {
            index,
            args: String::from_utf8(env::input().unwrap()).unwrap(),
            deposit: env::attached_deposit().as_yoctonear().to_string(),
            predecessor: env::predecessor_account_id().to_string(),
            prepaid_gas: env::prepaid_gas().as_gas().to_string(),
            yield_id,
        });
        self.fail.push(false);
        self.outputs.push(String::new());
        env::promise_return(promise);
    }
    // This unauthenticated resumer exists only in a local mock.
    pub fn resume(&mut self, index: u64, output: String, fail: bool) -> bool {
        self.fail[index as usize] = fail;
        self.outputs[index as usize] = output;
        // Runtime resume data is limited to 1024 bytes; the output stays in mock
        // storage and is returned raw by the actual yielded dependency receipt.
        env::promise_yield_resume(&self.records[index as usize].yield_id, b"ready")
    }
    #[private]
    pub fn on_result(&self, index: u64) {
        assert!(!self.fail[index as usize], "controlled executor failure");
        env::promise_result_checked(0, 8).expect("mock yield timed out");
        env::value_return(self.outputs[index as usize].as_bytes());
    }
    pub fn get_count(&self) -> u64 {
        self.records.len() as u64
    }
    pub fn get_records(&self) -> Vec<Value> {
        self.records.iter().map(|r|json!({"index":r.index,"args":serde_json::from_str::<Value>(&r.args).unwrap(),"deposit":r.deposit,"predecessor":r.predecessor,"prepaid_gas":r.prepaid_gas})).collect()
    }
    pub fn get_mpc_args(&self) -> Option<Value> {
        self.mpc_args
            .as_ref()
            .map(|s| serde_json::from_str(s).unwrap())
    }
}
