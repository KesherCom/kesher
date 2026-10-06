//! Sound card selection on ALSA.
//!
//! cpal names ALSA devices by their PCM name ("plughw:CARD=Headset,DEV=0",
//! "sysdefault:CARD=Headset", ...), which says little about the hardware.
//! The friendly names ("Logitech USB Headset") live in /proc/asound/cards,
//! so a configured name such as "USB" or "Logitech" is matched against
//! those and mapped to the card's `plughw` device: direct hardware access
//! (no mixer daemon, lowest latency) with format conversion, since many USB
//! headsets only take 16-bit samples while the engine renders f32.

use cpal::traits::{DeviceTrait, HostTrait};

#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    pub index: u32,
    /// Short ALSA id, e.g. "Headset" (used in "CARD=Headset").
    pub id: String,
    /// Driver + long name, e.g. "USB-Audio - Logitech USB Headset H340".
    pub description: String,
}

/// Parses /proc/asound/cards:
///  0 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones
///                       bcm2835 Headphones
///  1 [H340           ]: USB-Audio - Logitech USB Headset H340
///                       Logitech Logitech USB Headset H340 at usb-...
pub fn parse_cards(text: &str) -> Vec<Card> {
    let mut cards = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        let Some((index, rest)) = trimmed.split_once(' ') else { continue };
        let Ok(index) = index.parse::<u32>() else { continue };
        let Some(open) = rest.find('[') else { continue };
        let Some(close) = rest.find(']') else { continue };
        let id = rest[open + 1..close].trim().to_string();
        let description = rest[close + 1..].trim_start_matches(':').trim().to_string();
        cards.push(Card { index, id, description });
    }
    cards
}

pub fn cards() -> Vec<Card> {
    std::fs::read_to_string("/proc/asound/cards")
        .map(|t| parse_cards(&t))
        .unwrap_or_default()
}

pub fn device_names(input: bool) -> Vec<String> {
    let host = cpal::default_host();
    let devices = if input { host.input_devices() } else { host.output_devices() };
    devices
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

/// Maps the configured name to an exact cpal device name. None: system
/// default. Err: nothing matches (the message lists what exists).
pub fn resolve(wanted: Option<&str>, input: bool) -> Result<Option<String>, String> {
    let Some(wanted) = wanted.map(str::trim).filter(|w| !w.is_empty() && *w != "default") else {
        return Ok(None);
    };
    pick(wanted, &cards(), &device_names(input)).ok_or_else(|| {
        format!(
            "no {} device matches {wanted:?}. Sound cards: {}. Run `kesher-node devices` for details.",
            if input { "input" } else { "output" },
            describe_cards(&cards())
        )
    })
    .map(Some)
}

fn describe_cards(cards: &[Card]) -> String {
    if cards.is_empty() {
        return "none found".to_string();
    }
    cards
        .iter()
        .map(|c| format!("{} ({})", c.id, c.description))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Exact device name first; else the first card whose id or description
/// contains `wanted` (case-insensitive), opened through its best PCM.
pub fn pick(wanted: &str, cards: &[Card], devices: &[String]) -> Option<String> {
    if devices.iter().any(|d| d == wanted) {
        return Some(wanted.to_string());
    }
    let needle = wanted.to_lowercase();
    let card = cards
        .iter()
        .find(|c| c.id.to_lowercase() == needle)
        .or_else(|| {
            cards
                .iter()
                .find(|c| c.id.to_lowercase().contains(&needle) || c.description.to_lowercase().contains(&needle))
        })?;
    let preferred = [
        format!("plughw:CARD={},DEV=0", card.id),
        format!("sysdefault:CARD={}", card.id),
        format!("hw:CARD={},DEV=0", card.id),
    ];
    preferred
        .into_iter()
        .find(|p| devices.iter().any(|d| d == p))
        .or_else(|| devices.iter().find(|d| d.contains(&format!("CARD={}", card.id))).cloned())
}

/// `kesher-node devices`: what the node would use for each config value.
pub fn print_report() {
    let cards = cards();
    println!("Sound cards (/proc/asound/cards):");
    if cards.is_empty() {
        println!("  none found");
    }
    for c in &cards {
        println!("  {:>2}  {:<16} {}", c.index, c.id, c.description);
    }
    for (input, label) in [(true, "Input (mic)"), (false, "Output (headphones)")] {
        println!("\n{label} devices:");
        for name in device_names(input) {
            println!("  {name}");
        }
    }
    println!("\nIn node.toml, set audio.input / audio.output to a card id or part of its");
    println!("name (e.g. \"USB\"); the node then opens that card's plughw device.");
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROC: &str = " 0 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones
                      bcm2835 Headphones
 1 [vc4hdmi        ]: vc4-hdmi - vc4-hdmi
                      vc4-hdmi
 2 [H340           ]: USB-Audio - Logitech USB Headset H340
                      Logitech Logitech USB Headset H340 at usb-0000:01:00.0-1.3, full speed
";

    #[test]
    fn parses_proc_cards() {
        let cards = parse_cards(PROC);
        assert_eq!(cards.len(), 3);
        assert_eq!(cards[2].index, 2);
        assert_eq!(cards[2].id, "H340");
        assert_eq!(cards[2].description, "USB-Audio - Logitech USB Headset H340");
    }

    #[test]
    fn picks_plughw_of_matching_card() {
        let cards = parse_cards(PROC);
        let devices: Vec<String> = [
            "default",
            "sysdefault:CARD=Headphones",
            "hw:CARD=H340,DEV=0",
            "plughw:CARD=H340,DEV=0",
            "sysdefault:CARD=H340",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(pick("usb", &cards, &devices).as_deref(), Some("plughw:CARD=H340,DEV=0"));
        assert_eq!(pick("Logitech", &cards, &devices).as_deref(), Some("plughw:CARD=H340,DEV=0"));
        assert_eq!(pick("sysdefault:CARD=H340", &cards, &devices).as_deref(), Some("sysdefault:CARD=H340"));
        assert_eq!(pick("Focusrite", &cards, &devices), None);
        // Card without a plughw entry falls back to sysdefault.
        assert_eq!(pick("headphones", &cards, &devices).as_deref(), Some("sysdefault:CARD=Headphones"));
    }
}
