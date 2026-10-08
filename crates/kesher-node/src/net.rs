//! Minimal HTTP(S) and WebSocket client for the node's control connection.
//!
//! The node only needs one JSON POST (login/logout) and the `/ws` socket,
//! so instead of a full HTTP client both run over one connector here:
//! plain TCP or rustls (ring, no system OpenSSL). Self-signed LAN servers
//! are trusted on first use (see `Trust`).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use sha2::{Digest, Sha256};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::WebSocketStream;
use url::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HTTP_RESPONSE: usize = 1 << 20;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
pub type Stream = Box<dyn Io>;
pub type Ws = WebSocketStream<Stream>;

/// Why a WebSocket connect failed; `Unauthorized` means the token is gone.
#[derive(Debug)]
pub enum WsError {
    Unauthorized,
    Other(String),
}

/// How the node trusts HTTPS servers:
/// - a certificate from a public CA is verified normally;
/// - otherwise (the usual self-signed LAN server) the certificate is
///   trusted on first use and remembered per server, like SSH host keys;
///   a later different certificate is refused (`server-certs.json` in the
///   state dir; delete the entry after `kesher new-certificate`);
/// - `tls_insecure = true` accepts any certificate.
#[derive(Clone)]
pub struct Trust {
    inner: Arc<TrustInner>,
}

struct TrustInner {
    insecure: bool,
    pin_file: Option<PathBuf>,
    pins: Mutex<BTreeMap<String, String>>,
}

impl Trust {
    pub fn new(insecure: bool, pin_file: Option<PathBuf>) -> Self {
        let pins = pin_file
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        Self { inner: Arc::new(TrustInner { insecure, pin_file, pins: Mutex::new(pins) }) }
    }

    /// Checks a certificate that no public CA vouches for.
    fn check_unverified(&self, server: &str, cert: &CertificateDer<'_>) -> Result<(), rustls::Error> {
        if self.inner.insecure {
            return Ok(());
        }
        let fingerprint: String = Sha256::digest(cert.as_ref()).iter().map(|b| format!("{b:02x}")).collect();
        let mut pins = self.inner.pins.lock().unwrap();
        match pins.get(server) {
            Some(known) if *known == fingerprint => Ok(()),
            Some(_) => Err(rustls::Error::General(format!(
                "the certificate of {server} changed. If the server got a new certificate, remove its entry from {}",
                self.inner.pin_file.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "server-certs.json".into())
            ))),
            None => {
                log::info!("trusting the certificate of {server} from now on (SHA-256 {fingerprint})");
                pins.insert(server.to_string(), fingerprint);
                if let Some(path) = &self.inner.pin_file {
                    if let Ok(text) = serde_json::to_string_pretty(&*pins) {
                        let _ = std::fs::write(path, text);
                    }
                }
                Ok(())
            }
        }
    }
}

/// Debug wrapper so the verifier can derive Debug.
struct TrustRef(Trust);

impl std::fmt::Debug for TrustRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Trust")
    }
}

#[derive(Debug)]
struct NodeVerifier {
    webpki: Arc<WebPkiServerVerifier>,
    trust: TrustRef,
    server: String,
}

impl ServerCertVerifier for NodeVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self.webpki.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now) {
            Ok(ok) => Ok(ok),
            Err(_) => self.trust.0.check_unverified(&self.server, end_entity).map(|_| ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.webpki.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.webpki.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.webpki.supported_verify_schemes()
    }
}

async fn connect(url: &Url, trust: &Trust) -> Result<Stream, String> {
    let host = url.host_str().ok_or("server URL has no host")?.to_string();
    let port = url.port_or_known_default().ok_or("server URL has no port")?;
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| format!("connect {host}:{port}: timeout"))?
        .map_err(|e| format!("connect {host}:{port}: {e}"))?;
    let _ = tcp.set_nodelay(true);
    if !matches!(url.scheme(), "https" | "wss") {
        return Ok(Box::new(tcp));
    }
    // Bracketless form for IPv6 literals.
    let name = ServerName::try_from(host.trim_matches(['[', ']']).to_string()).map_err(|e| format!("tls name {host}: {e}"))?;
    let tls = TlsConnector::from(tls_config(trust, format!("{host}:{port}"))?)
        .connect(name, tcp)
        .await
        .map_err(|e| format!("tls handshake with {host}: {e}"))?;
    Ok(Box::new(tls))
}

fn tls_config(trust: &Trust, server: String) -> Result<Arc<ClientConfig>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let webpki = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), Arc::clone(&provider))
        .build()
        .map_err(|e| format!("tls setup: {e}"))?;
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NodeVerifier { webpki, trust: TrustRef(trust.clone()), server }))
        .with_no_client_auth();
    Ok(Arc::new(config))
}

/// `path` below the server URL's own path (servers behind a path prefix).
fn endpoint(base: &Url, path: &str) -> String {
    format!("{}{}", base.path().trim_end_matches('/'), path)
}

fn host_header(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

/// POSTs JSON and returns (status, body). HTTP/1.0 so the server answers
/// with a plain body (no chunking) and closes the connection.
pub async fn post_json(
    base: &Url,
    path: &str,
    body: &serde_json::Value,
    bearer: Option<&str>,
    trust: &Trust,
) -> Result<(u16, String), String> {
    let body = body.to_string();
    let auth = bearer.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let request = format!(
        "POST {} HTTP/1.0\r\nHost: {}\r\nUser-Agent: kesher-node/{}\r\nContent-Type: application/json\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        endpoint(base, path),
        host_header(base),
        crate::VERSION,
        body.len(),
    );
    let exchange = async {
        let mut stream = connect(base, trust).await?;
        stream.write_all(request.as_bytes()).await.map_err(|e| format!("send: {e}"))?;
        stream.flush().await.map_err(|e| format!("send: {e}"))?;
        let mut response = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    response.extend_from_slice(&chunk[..n]);
                    if response.len() > MAX_HTTP_RESPONSE {
                        return Err("response too large".to_string());
                    }
                }
                // TLS peers may close without close_notify; the body is
                // complete because HTTP/1.0 ends it with the connection.
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof && !response.is_empty() => break,
                Err(e) => return Err(format!("receive: {e}")),
            }
        }
        Ok(response)
    };
    let response = tokio::time::timeout(HTTP_TIMEOUT, exchange)
        .await
        .map_err(|_| format!("{path}: timeout"))??;
    parse_response(&response)
}

fn parse_response(raw: &[u8]) -> Result<(u16, String), String> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text.split_once("\r\n\r\n").ok_or("malformed HTTP response")?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or("malformed HTTP status line")?;
    Ok((status, body.to_string()))
}

/// Opens `/ws?token=..&transport=native`.
pub async fn connect_ws(base: &Url, token: &str, trust: &Trust) -> Result<Ws, WsError> {
    let mut url = base.clone();
    let scheme = if base.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).map_err(|_| WsError::Other("bad server URL".into()))?;
    url.set_path(&endpoint(base, "/ws"));
    url.query_pairs_mut()
        .clear()
        .append_pair("token", token)
        .append_pair("transport", "native");
    let stream = connect(base, trust).await.map_err(WsError::Other)?;
    match tokio::time::timeout(HTTP_TIMEOUT, tokio_tungstenite::client_async(url.as_str(), stream)).await {
        Err(_) => Err(WsError::Other("websocket handshake: timeout".into())),
        Ok(Ok((ws, _))) => Ok(ws),
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(resp)))
            if matches!(resp.status().as_u16(), 401 | 403) =>
        {
            Err(WsError::Unauthorized)
        }
        Ok(Err(e)) => Err(WsError::Other(format!("websocket: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_and_body() {
        let (status, body) = parse_response(b"HTTP/1.0 409 Conflict\r\nContent-Type: application/json\r\n\r\n{\"a\":1}").unwrap();
        assert_eq!(status, 409);
        assert_eq!(body, "{\"a\":1}");
        assert!(parse_response(b"garbage").is_err());
    }

    #[test]
    fn keeps_path_prefix() {
        let base = Url::parse("https://intercom.example.org/kesher/").unwrap();
        assert_eq!(endpoint(&base, "/api/login"), "/kesher/api/login");
        let root = Url::parse("http://10.0.0.1:8080").unwrap();
        assert_eq!(endpoint(&root, "/ws"), "/ws");
        assert_eq!(host_header(&root), "10.0.0.1:8080");
    }

    #[test]
    fn trusts_first_certificate_and_refuses_a_changed_one() {
        let dir = std::env::temp_dir().join(format!("kesher-trust-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("server-certs.json");
        let _ = std::fs::remove_file(&file);
        let first = CertificateDer::from(vec![1u8, 2, 3]);
        let other = CertificateDer::from(vec![9u8, 9, 9]);

        let trust = Trust::new(false, Some(file.clone()));
        assert!(trust.check_unverified("10.0.0.1:8443", &first).is_ok());
        assert!(trust.check_unverified("10.0.0.1:8443", &first).is_ok());
        assert!(trust.check_unverified("10.0.0.1:8443", &other).is_err());
        // Another server has its own entry.
        assert!(trust.check_unverified("10.0.0.2:8443", &other).is_ok());
        // Remembered across restarts.
        let reloaded = Trust::new(false, Some(file.clone()));
        assert!(reloaded.check_unverified("10.0.0.1:8443", &other).is_err());
        // tls_insecure accepts anything.
        assert!(Trust::new(true, None).check_unverified("10.0.0.1:8443", &other).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
