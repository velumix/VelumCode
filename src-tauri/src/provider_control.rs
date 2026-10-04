use crate::{codex_control, events::AgentEvent, interactions::Broker, muse_msp};
use std::sync::Arc;

pub enum Client {
    Muse(muse_msp::Client),
    Codex(codex_control::Client),
}
impl Client {
    pub fn broker(&self) -> &Arc<Broker> {
        match self {
            Self::Muse(client) => &client.broker,
            Self::Codex(client) => &client.broker,
        }
    }
    pub fn session_id(&self) -> &Option<String> {
        match self {
            Self::Muse(client) => &client.session_id,
            Self::Codex(client) => &client.session_id,
        }
    }
    pub fn run_id(&self) -> &Option<String> {
        match self {
            Self::Muse(client) => &client.run_id,
            Self::Codex(client) => &client.run_id,
        }
    }
    pub fn denied(&self) -> bool {
        match self {
            Self::Muse(client) => client.denied,
            Self::Codex(client) => client.denied,
        }
    }
    pub fn effective(&self) -> Option<&serde_json::Value> {
        match self {
            Self::Muse(_) => None,
            Self::Codex(client) => client.effective.as_ref(),
        }
    }
    pub fn settling(&self) -> bool {
        match self {
            Self::Muse(client) => client.settling(),
            Self::Codex(client) => client.settling(),
        }
    }
    pub fn poll(&mut self) -> Result<(), String> {
        match self {
            Self::Muse(client) => client.poll(),
            Self::Codex(client) => client.poll(),
        }
    }
    pub fn observe_line(&mut self, line: &str) -> Result<Vec<AgentEvent>, String> {
        match self {
            Self::Muse(client) => client.observe_line(line),
            Self::Codex(client) => client.observe_line(line),
        }
    }
}
