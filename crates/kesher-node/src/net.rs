//! Minimal HTTP(S) and WebSocket client for the node's control connection.
//!
//! The node only needs one JSON POST (login/logout) and the `/ws` socket,
//! so instead of a full HTTP client both run over one connector here:
//! plain TCP or rustls (ring, no system OpenSSL), with an opt-in verifier
//! that accepts self-signed certificates for LAN servers.

use std::sync::Arc;
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
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

async fn connect(url: &Url, insecure: bool) -> Result<Stream, String> {
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
    let tls = TlsConnector::from(tls_config(insecure))
        .connect(name, tcp)
        .await
        .map_err(|e| format!("tls handshake with {host}: {e}"))?;
    Ok(Box::new(tls))
}

fn tls_config(insecure: bool) -> Arc<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions");
    let config = if insecure {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCert(provider)))
            .with_no_client_auth()
    } else {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        builder.with_root_certificates(roots).with_no_client_auth()
    };
    Arc::new(config)
}

/// `tls_insecure = true`: any certificate is accepted (signatures are still
/// checked, so the session is encrypted, just not authenticated).
#[derive(Debug)]
struct AcceptAnyCert(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
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
    insecure: bool,
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
        let mut stream = connect(base, insecure).await?;
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
pub async fn connect_ws(base: &Url, token: &str, insecure: bool) -> Result<Ws, WsError> {
    let mut url = base.clone();
    let scheme = if base.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).map_err(|_| WsError::Other("bad server URL".into()))?;
    url.set_path(&endpoint(base, "/ws"));
    url.query_pairs_mut()
        .clear()
        .append_pair("token", token)
        .append_pair("transport", "native");
    let stream = connect(base, insecure).await.map_err(WsError::Other)?;
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
}
