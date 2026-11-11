//! A small allowlist of provider connection facts, never raw request metadata.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Connecting,
    Retrying,
    Connected,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Progress {
    pub phase: Phase,
    pub checked_at_ms: u64,
    pub attempt: Option<u64>,
    pub max_attempts: Option<u64>,
    pub http_status: Option<u64>,
    pub retry_at_ms: Option<u64>,
}

impl Progress {
    pub fn message(&self) -> String {
        match self.phase {
            Phase::Connecting => "Connecting to Muse…".into(),
            Phase::Connected => "Muse response received".into(),
            Phase::Retrying => match self.http_status {
                Some(401) => "Muse sign-in was rejected (HTTP 401)".into(),
                Some(403) => "Muse service denied the request (HTTP 403)".into(),
                Some(429) => "Muse service is rate limited (HTTP 429)".into(),
                Some(code @ 500..=599) => {
                    format!("Muse service is temporarily unavailable (HTTP {code})")
                }
                Some(code) => format!("Muse request failed (HTTP {code})"),
                None => "Muse connection was interrupted".into(),
            },
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

pub fn muse(details: &Value, now: u64) -> Option<Progress> {
    let phase = match details["phase"].as_str()? {
        "opening_stream" => Phase::Connecting,
        "retry_scheduled" => Phase::Retrying,
        "stream_succeeded" => Phase::Connected,
        _ => return None,
    };
    let facets = details["facets"].as_array();
    let attempt = facets.into_iter().flatten().find(|f| {
        f["kind"] == "external_attempt"
            && f["system"] == "meta"
            && f["operation"] == "model.response"
    });
    // Healthy lifecycle phases often omit retry metadata. They must still
    // replace an earlier retry; explicit facts for other operations are ignored.
    if attempt.is_none()
        && facets.is_some_and(|items| items.iter().any(|f| f["kind"] == "external_attempt"))
    {
        return None;
    }
    let attempt = attempt.unwrap_or(&Value::Null);
    let count = |key: &str| attempt[key].as_u64().filter(|n| (1..=1000).contains(n));
    let retrying = phase == Phase::Retrying;
    Some(Progress {
        phase,
        checked_at_ms: now,
        attempt: if retrying {
            count("next_attempt")
        } else {
            count("attempt")
        },
        max_attempts: count("max_attempts"),
        http_status: retrying
            .then(|| {
                attempt["http_status"]
                    .as_u64()
                    .filter(|s| (100..=599).contains(s))
            })
            .flatten(),
        retry_at_ms: retrying
            .then(|| {
                attempt["retry_delay_ms"]
                    .as_u64()
                    .filter(|delay| *delay <= 86_400_000)
                    .and_then(|delay| now.checked_add(delay))
            })
            .flatten(),
    })
}

pub fn claude_retry(value: &Value, now: u64) -> Option<Progress> {
    if value["type"] != "system" || value["subtype"] != "api_retry" {
        return None;
    }
    let count = |key: &str| value[key].as_u64().filter(|n| (1..=1000).contains(n));
    let delay_ms = value["retry_delay_ms"]
        .as_f64()
        .filter(|ms| ms.is_finite() && *ms > 0.0 && *ms <= 86_400_000.0)
        .map(|ms| ms.round() as u64)
        .or_else(|| {
            value["retry_delay_ms"]
                .as_u64()
                .filter(|ms| *ms > 0 && *ms <= 86_400_000)
        });
    Some(Progress {
        phase: Phase::Retrying,
        checked_at_ms: now,
        attempt: count("attempt"),
        max_attempts: count("max_retries"),
        http_status: value["error_status"]
            .as_u64()
            .filter(|code| (100..=599).contains(code)),
        retry_at_ms: delay_ms.and_then(|ms| now.checked_add(ms)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn real_muse_retry_shape_preserves_only_safe_facts() {
        let status = muse(&json!({"phase":"retry_scheduled","facets":[
            {"kind":"external_attempt","system":"meta","operation":"model.response","attempt":1,"next_attempt":2,"max_attempts":10,"retry_delay_ms":60000,"http_status":503,"error_kind":"server","token":"PRIVATE"},
            {"kind":"producer","detail":{"request_id":"PRIVATE","url":"https://private.example/"}}
        ]}), 1000).unwrap();
        assert_eq!(status.phase, Phase::Retrying);
        assert_eq!(status.retry_at_ms, Some(61_000));
        assert_eq!(status.attempt, Some(2));
        assert_eq!(status.max_attempts, Some(10));
        assert_eq!(
            status.message(),
            "Muse service is temporarily unavailable (HTTP 503)"
        );
        assert!(!serde_json::to_string(&status).unwrap().contains("PRIVATE"));
    }

    #[test]
    fn success_clears_errors_and_malformed_metadata_is_not_trusted() {
        let mut details = json!({"phase":"stream_succeeded","facets":[{"kind":"external_attempt","system":"meta","operation":"model.response","attempt":2,"max_attempts":10,"http_status":503,"retry_delay_ms":60000}]});
        let status = muse(&details, 3000).unwrap();
        assert_eq!(status.phase, Phase::Connected);
        assert_eq!(status.http_status, None);
        assert_eq!(status.retry_at_ms, None);
        details["phase"] = json!("retry_scheduled");
        details["facets"][0]["retry_delay_ms"] = json!(-1);
        details["facets"][0]["next_attempt"] = json!("PRIVATE");
        details["facets"][0]["http_status"] = json!(9999);
        let status = muse(&details, 0).unwrap();
        assert_eq!(status.attempt, None);
        assert_eq!(status.http_status, None);
        assert_eq!(status.retry_at_ms, None);
        details["facets"][0]["operation"] = json!("tool.response");
        assert!(muse(&details, 0).is_none());
    }
    #[test]
    fn healthy_phases_without_attempt_facets_replace_retry_states() {
        let connecting = muse(&json!({"phase":"opening_stream"}), 1000).unwrap();
        assert_eq!(connecting.phase, Phase::Connecting);
        assert_eq!(connecting.http_status, None);
        let connected = muse(&json!({"phase":"stream_succeeded","facets":[]}), 2000).unwrap();
        assert_eq!(connected.phase, Phase::Connected);
        assert_eq!(connected.retry_at_ms, None);
        assert!(muse(&json!({"phase":"arbitrary"}), 3000).is_none());
    }
    #[test]
    fn claude_retry_preserves_safe_retry_metadata() {
        let status = claude_retry(
            &json!({"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":1250.4,"error_status":429}),
            5000,
        )
        .unwrap();
        assert_eq!(status.phase, Phase::Retrying);
        assert_eq!(status.attempt, Some(2));
        assert_eq!(status.max_attempts, Some(10));
        assert_eq!(status.http_status, Some(429));
        assert_eq!(status.retry_at_ms, Some(6250));
    }
}
