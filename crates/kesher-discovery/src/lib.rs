//! Finds Kesher servers on the local network. The server announces itself
//! via mDNS/DNS-SD as `_kesher._tcp` (backend/internal/app/discovery.go)
//! with TXT `scheme=http|https`; this browses for it. Used by kesher-node
//! (no `server` in its config) and the desktop app ("servers found").

use std::collections::BTreeMap;
use std::net::Ipv4Addr;
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;

pub const SERVICE_TYPE: &str = "_kesher._tcp.local.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FoundServer {
    /// Name the server announces, e.g. "Kesher (intercom-server)".
    pub name: String,
    /// Base URL to connect to, e.g. "https://192.168.1.10:8443".
    pub url: String,
    /// Plain-HTTP address for native clients that cannot use the server's
    /// self-signed certificate (the desktop app's WebView), when the server
    /// offers one (TXT http_port), e.g. "http://192.168.1.10:8080".
    pub http_url: Option<String>,
    pub version: String,
}

/// Browses for `timeout` and returns every server found, sorted by name.
/// Blocking; call it from a thread (or `spawn_blocking`).
pub fn discover(timeout: Duration) -> Result<Vec<FoundServer>, String> {
    let daemon = ServiceDaemon::new().map_err(|e| format!("mdns: {e}"))?;
    let events = daemon.browse(SERVICE_TYPE).map_err(|e| format!("mdns browse: {e}"))?;
    let deadline = Instant::now() + timeout;
    let mut found = BTreeMap::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let Ok(event) = events.recv_timeout(left) else { break };
        if let ServiceEvent::ServiceResolved(service) = event {
            let scheme = match service.get_property_val_str("scheme") {
                Some("https") => "https",
                _ => "http",
            };
            let Some(ip) = pick_address(service.get_addresses_v4()) else { continue };
            let name = instance_name(service.get_fullname());
            let http_url = service
                .get_property_val_str("http_port")
                .and_then(|p| p.parse::<u16>().ok())
                .map(|p| format!("http://{ip}:{p}"))
                .or_else(|| (scheme == "http").then(|| format!("http://{ip}:{}", service.get_port())));
            let server = FoundServer {
                url: format!("{scheme}://{ip}:{}", service.get_port()),
                http_url,
                version: service.get_property_val_str("version").unwrap_or("").to_string(),
                name: name.clone(),
            };
            log::debug!("found Kesher server {server:?}");
            found.insert(name, server);
        }
    }
    let _ = daemon.shutdown();
    Ok(found.into_values().collect())
}

/// One stable LAN address: private ranges first, then the lowest.
fn pick_address(addrs: impl IntoIterator<Item = Ipv4Addr>) -> Option<Ipv4Addr> {
    let mut addrs: Vec<Ipv4Addr> = addrs.into_iter().filter(|a| !a.is_loopback() && !a.is_link_local()).collect();
    addrs.sort_by_key(|a| (!a.is_private(), *a));
    addrs.first().copied()
}

/// "Kesher (box)._kesher._tcp.local." -> "Kesher (box)"
fn instance_name(fullname: &str) -> String {
    fullname
        .strip_suffix(SERVICE_TYPE)
        .map(|s| s.trim_end_matches('.'))
        .unwrap_or(fullname)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_private_lan_address() {
        let addrs = [
            Ipv4Addr::new(169, 254, 3, 1),
            Ipv4Addr::new(203, 0, 113, 5),
            Ipv4Addr::new(192, 168, 1, 10),
            Ipv4Addr::new(127, 0, 0, 1),
        ];
        assert_eq!(pick_address(addrs), Some(Ipv4Addr::new(192, 168, 1, 10)));
        assert_eq!(pick_address([]), None);
    }

    #[test]
    fn strips_service_type_from_name() {
        assert_eq!(instance_name("Kesher (box)._kesher._tcp.local."), "Kesher (box)");
        assert_eq!(instance_name("odd"), "odd");
    }
}
