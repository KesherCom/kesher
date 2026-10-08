//! kesher-node: headless Kesher intercom station for Raspberry Pi 3/4/5
//! (and any other Linux box with a sound card). Runs as a systemd service,
//! configured by /etc/kesher/node.toml; uses the same audio engine as the
//! desktop app (crates/kesher-audio). Setup: docs/hardware/raspberry-pi.md.

mod config;
mod devices;
mod gpio;
mod net;
mod session;

use std::path::PathBuf;

use config::Config;

/// Release version (set by the release build from the git tag), else the
/// crate version.
pub const VERSION: &str = match option_env!("KESHER_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

const USAGE: &str = "usage: kesher-node [run|check|devices] [--config PATH]

  run       join the intercom (default; what the service runs)
  check     validate the config and show which sound cards it selects
  devices   list sound cards and ALSA devices
  --config  config file (default /etc/kesher/node.toml)
  --version print the version";

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp(None) // journald adds its own
        .init();
    let mut command = "run".to_string();
    let mut config_path = PathBuf::from(config::DEFAULT_CONFIG_PATH);
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" | "-c" => match args.next() {
                Some(p) => config_path = PathBuf::from(p),
                None => exit_usage("--config needs a path"),
            },
            "--version" | "-V" => {
                println!("kesher-node {VERSION}");
                return;
            }
            "--help" | "-h" => {
                println!("{USAGE}");
                return;
            }
            "run" | "check" | "devices" => command = arg,
            other => exit_usage(&format!("unknown argument {other:?}")),
        }
    }
    match command.as_str() {
        "devices" => devices::print_report(),
        "check" => check(&config_path),
        _ => run(&config_path),
    }
}

fn exit_usage(msg: &str) -> ! {
    eprintln!("{msg}\n\n{USAGE}");
    std::process::exit(2);
}

fn load(path: &std::path::Path) -> Config {
    match Config::load(path) {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("config error: {e}");
            // Exit code 78 (EX_CONFIG): the unit does not restart-loop on it.
            std::process::exit(78);
        }
    }
}

fn check(path: &std::path::Path) {
    let cfg = load(path);
    println!("config ok");
    let mut ok = true;
    match cfg.server_url() {
        Some(server) => println!("server: {server}"),
        None => match kesher_discovery::discover(std::time::Duration::from_secs(3)) {
            Ok(found) if !found.is_empty() => {
                for f in &found {
                    let http = f.http_url.as_deref().map(|u| format!(", desktop app: {u}")).unwrap_or_default();
                    println!("server: found {:?} at {}{http} (version {})", f.name, f.url, f.version);
                }
            }
            Ok(_) => {
                println!("server: none found on this network (set server = \"https://<ip>:8443\" in the config)");
                ok = false;
            }
            Err(e) => {
                println!("server: discovery failed: {e}");
                ok = false;
            }
        },
    }
    match cfg.role() {
        Some(role) => println!("login: role {role:?} as {:?}, mode {:?}", cfg.username(), cfg.mode),
        None => println!("login: station pairing (approve it in the admin area -> Stations)"),
    }
    for (input, wanted, label) in [(true, &cfg.audio.input, "input"), (false, &cfg.audio.output, "output")] {
        match devices::resolve(wanted.as_deref(), input) {
            Ok(Some(name)) => println!("{label}: {name}"),
            Ok(None) => println!("{label}: system default"),
            Err(e) => {
                println!("{label}: {e}");
                ok = false;
            }
        }
    }
    if !ok {
        std::process::exit(1);
    }
}

fn run(path: &std::path::Path) {
    let cfg = load(path);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        let (talk_tx, talk_rx) = tokio::sync::mpsc::unbounded_channel();
        if let Some(pin) = cfg.gpio.talk_button {
            if let Err(e) = gpio::spawn_button(pin, talk_tx.clone()) {
                log::error!("talk button: {e}");
            }
        }
        let led = match cfg.gpio.talk_led {
            Some(pin) => gpio::spawn_led(pin).unwrap_or_else(|e| {
                log::error!("talk LED: {e}");
                gpio::Led::default()
            }),
            None => gpio::Led::default(),
        };
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        tokio::spawn(async move {
            wait_for_signal().await;
            log::info!("stopping");
            let _ = shutdown_tx.send(true);
        });
        session::Node::new(cfg, led).run(talk_rx, shutdown_rx).await;
        drop(talk_tx);
    });
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
