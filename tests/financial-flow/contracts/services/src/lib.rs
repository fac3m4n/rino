//! LOCAL ONLY. Real yielded receipts; fixed controller and supervisor authorization.
use near_sdk::serde_json::{self, Value, json};
use near_sdk::{AccountId, Gas, GasWeight, PanicOnDefault, env, near};
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Record {
    index: u64,
    kind: String,
    args: String,
    deposit: String,
    predecessor: String,
    prepaid_gas: String,
    yield_id: [u8; 32],
}
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Services {
    controller: AccountId,
    operator: AccountId,
    public_key: String,
    records: Vec<Record>,
    outputs: Vec<String>,
    failed: Vec<bool>,
}
#[near]
impl Services {
    #[init]
    pub fn new(controller: AccountId, operator: AccountId, public_key: String) -> Self {
        assert_eq!(env::predecessor_account_id(), env::current_account_id());
        Self {
            controller,
            operator,
            public_key,
            records: vec![],
            outputs: vec![],
            failed: vec![],
        }
    }
    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: AccountId,
        domain_id: u64,
    ) -> String {
        assert_eq!(env::predecessor_account_id(), self.controller);
        assert_eq!(predecessor, self.controller);
        assert_eq!(path, "rino:sepolia:v1:0");
        assert_eq!(domain_id, 0);
        self.public_key.clone()
    }
    #[payable]
    pub fn request_execution(&mut self) {
        self.enqueue("execution");
    }
    #[payable]
    pub fn sign(&mut self) {
        self.enqueue("signature");
    }
    pub fn resume(&mut self, index: u64, output: String, fail: bool) -> bool {
        assert_eq!(env::predecessor_account_id(), self.operator);
        assert!(output.len() <= 8192);
        self.outputs[index as usize] = output;
        self.failed[index as usize] = fail;
        env::promise_yield_resume(&self.records[index as usize].yield_id, b"ready")
    }
    #[private]
    pub fn on_result(&self, index: u64) {
        assert!(
            !self.failed[index as usize],
            "controlled local service failure"
        );
        env::promise_result_checked(0, 8).expect("local yield timeout");
        env::value_return(self.outputs[index as usize].as_bytes());
    }
    pub fn get_records(&self) -> Vec<Value> {
        self.records.iter().map(|r|json!({"index":r.index,"kind":r.kind,"args":serde_json::from_str::<Value>(&r.args).unwrap(),"deposit":r.deposit,"predecessor":r.predecessor,"prepaid_gas":r.prepaid_gas})).collect()
    }
}
impl Services {
    fn enqueue(&mut self, kind: &str) {
        assert_eq!(env::predecessor_account_id(), self.controller);
        assert!(self.records.len() < 64, "local bounded job limit");
        let input = env::input().expect("input");
        assert!(input.len() <= 40000);
        let index = self.records.len() as u64;
        let promise = env::promise_yield_create(
            "on_result",
            serde_json::to_vec(&json!({"index":index})).unwrap(),
            Gas::from_tgas(15),
            GasWeight(0),
            0,
        );
        self.records.push(Record {
            index,
            kind: kind.into(),
            args: String::from_utf8(input).unwrap(),
            deposit: env::attached_deposit().as_yoctonear().to_string(),
            predecessor: env::predecessor_account_id().to_string(),
            prepaid_gas: env::prepaid_gas().as_gas().to_string(),
            yield_id: env::read_register(0).unwrap().try_into().unwrap(),
        });
        self.outputs.push(String::new());
        self.failed.push(false);
        env::promise_return(promise);
    }
}
