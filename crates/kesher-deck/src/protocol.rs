//! The USB HID protocol of the Stream Deck models we drive, as pure
//! functions (no device needed, so it is unit tested).
//!
//! Generation-2 decks (Stream Deck original v2, MK.2): input report 0x01
//! with a 4-byte header followed by one byte per key (1 = pressed);
//! images go out as output report 0x02 in 1024-byte packets of JPEG data;
//! reset and brightness are feature reports 0x03.

/// Elgato's USB vendor id.
pub const ELGATO_VENDOR_ID: u16 = 0x0fd9;

/// What the app needs to know about one deck model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Model {
    pub name: &'static str,
    pub product_id: u16,
    pub keys: usize,
    pub columns: usize,
    /// Key images are square, this many pixels per side.
    pub image_size: u32,
    /// Images must be rotated by 180 degrees before they are sent.
    pub image_rotated: bool,
}

const GEN2_15: Model = Model {
    name: "Stream Deck MK.2",
    product_id: 0x0080,
    keys: 15,
    columns: 5,
    image_size: 72,
    image_rotated: true,
};

/// The models this app drives. Other Elgato decks are reported as
/// unsupported (see [`elgato_model_name`]).
pub const SUPPORTED_MODELS: &[Model] = &[
    GEN2_15,
    // Stream Deck MK.2 with scissor keys (2023)
    Model { product_id: 0x00a5, ..GEN2_15 },
    // Stream Deck original, second revision: same protocol as the MK.2
    Model { name: "Stream Deck", product_id: 0x006d, ..GEN2_15 },
];

pub fn supported_model(product_id: u16) -> Option<Model> {
    SUPPORTED_MODELS.iter().copied().find(|m| m.product_id == product_id)
}

/// Names of Elgato decks we see but do not drive yet, for a clear message.
pub fn elgato_model_name(product_id: u16) -> &'static str {
    match product_id {
        0x0060 => "Stream Deck (first generation)",
        0x0063 | 0x0090 | 0x00b3 => "Stream Deck Mini",
        0x006c | 0x008f | 0x00ba => "Stream Deck XL",
        0x0084 => "Stream Deck +",
        0x0086 => "Stream Deck Pedal",
        0x009a => "Stream Deck Neo",
        _ => "Stream Deck (unknown model)",
    }
}

/// Size of an input report (key states) to read.
pub const INPUT_REPORT_LEN: usize = 512;
const KEY_STATE_OFFSET: usize = 4;

/// Key states from an input report, or None when it is not a key report.
pub fn parse_key_states(report: &[u8], keys: usize) -> Option<Vec<bool>> {
    if report.first() != Some(&0x01) || report.len() < KEY_STATE_OFFSET + keys {
        return None;
    }
    Some(report[KEY_STATE_OFFSET..KEY_STATE_OFFSET + keys].iter().map(|b| *b != 0).collect())
}

const IMAGE_REPORT_LEN: usize = 1024;
const IMAGE_HEADER_LEN: usize = 8;

/// Output reports that set one key's image (JPEG bytes, already sized and
/// rotated for the model).
pub fn image_reports(key: u8, jpeg: &[u8]) -> Vec<Vec<u8>> {
    let payload = IMAGE_REPORT_LEN - IMAGE_HEADER_LEN;
    let chunks: Vec<&[u8]> = if jpeg.is_empty() { vec![&[][..]] } else { jpeg.chunks(payload).collect() };
    let last = chunks.len() - 1;
    chunks
        .into_iter()
        .enumerate()
        .map(|(page, chunk)| {
            let mut report = vec![0u8; IMAGE_REPORT_LEN];
            report[0] = 0x02;
            report[1] = 0x07;
            report[2] = key;
            report[3] = u8::from(page == last);
            report[4..6].copy_from_slice(&(chunk.len() as u16).to_le_bytes());
            report[6..8].copy_from_slice(&(page as u16).to_le_bytes());
            report[IMAGE_HEADER_LEN..IMAGE_HEADER_LEN + chunk.len()].copy_from_slice(chunk);
            report
        })
        .collect()
}

const FEATURE_REPORT_LEN: usize = 32;

/// Feature report that clears all keys and shows the Elgato logo.
pub fn reset_report() -> Vec<u8> {
    let mut report = vec![0u8; FEATURE_REPORT_LEN];
    report[0] = 0x03;
    report[1] = 0x02;
    report
}

/// Feature report that sets the backlight, 0-100 %.
pub fn brightness_report(percent: u8) -> Vec<u8> {
    let mut report = vec![0u8; FEATURE_REPORT_LEN];
    report[0] = 0x03;
    report[1] = 0x08;
    report[2] = percent.min(100);
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_the_mk2() {
        let m = supported_model(0x0080).expect("MK.2");
        assert_eq!((m.keys, m.columns, m.image_size, m.image_rotated), (15, 5, 72, true));
        assert!(supported_model(0x0063).is_none());
        assert_eq!(elgato_model_name(0x0063), "Stream Deck Mini");
    }

    #[test]
    fn parses_key_states() {
        let mut report = vec![0u8; INPUT_REPORT_LEN];
        report[0] = 0x01;
        report[4] = 1; // key 0
        report[4 + 14] = 1; // key 14
        let keys = parse_key_states(&report, 15).unwrap();
        assert_eq!(keys.iter().filter(|k| **k).count(), 2);
        assert!(keys[0] && keys[14]);
        report[0] = 0x02;
        assert!(parse_key_states(&report, 15).is_none());
    }

    #[test]
    fn splits_images_into_reports() {
        let jpeg: Vec<u8> = (0..2500u32).map(|i| i as u8).collect();
        let reports = image_reports(7, &jpeg);
        assert_eq!(reports.len(), 3); // 1016 + 1016 + 468
        for (page, r) in reports.iter().enumerate() {
            assert_eq!(r.len(), 1024);
            assert_eq!(&r[..3], &[0x02, 0x07, 7]);
            assert_eq!(r[3], u8::from(page == 2));
            assert_eq!(u16::from_le_bytes([r[6], r[7]]) as usize, page);
        }
        assert_eq!(u16::from_le_bytes([reports[2][4], reports[2][5]]), 468);
        let joined: Vec<u8> = reports
            .iter()
            .flat_map(|r| {
                let len = u16::from_le_bytes([r[4], r[5]]) as usize;
                r[8..8 + len].to_vec()
            })
            .collect();
        assert_eq!(joined, jpeg);
    }

    #[test]
    fn feature_reports() {
        assert_eq!(&reset_report()[..2], &[0x03, 0x02]);
        assert_eq!(&brightness_report(150)[..3], &[0x03, 0x08, 100]);
    }
}
