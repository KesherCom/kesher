/**
 * Fader math shared by the party line cards and the sound settings: slider
 * positions are dB, the bottom position is mute.
 */
export const DB_MIN = -60;
export const OUTPUT_DB_MAX = 6; // +6 dB ~ gain 2.0
export const INPUT_DB_MAX = 18; // +18 dB ~ gain 7.94
export const MUTE_POS = DB_MIN - 1; // sentinel slider position for mute

/** Slider position (dB) -> linear gain. Bottom-of-slider = mute. */
export function sliderToGain(sliderDb: number, dbMax = OUTPUT_DB_MAX): number {
  if (sliderDb <= MUTE_POS) return 0;
  return Math.pow(10, Math.max(DB_MIN, Math.min(dbMax, sliderDb)) / 20);
}

/** Linear gain -> slider position (dB). */
export function gainToSlider(gain: number, dbMax = OUTPUT_DB_MAX): number {
  if (gain <= 0) return MUTE_POS;
  const db = 20 * Math.log10(gain);
  if (db < DB_MIN) return MUTE_POS;
  return Math.round(Math.max(DB_MIN, Math.min(dbMax, db)));
}

/** Gain -> display label like "+6 dB", "0 dB", "-inf". */
export function gainToDbLabel(gain: number, dbMax = OUTPUT_DB_MAX): string {
  if (gain <= 0) return "-\u221E";
  const db = 20 * Math.log10(gain);
  if (db < DB_MIN) return "-\u221E";
  const r = Math.round(Math.max(DB_MIN, Math.min(dbMax, db)));
  if (r === 0) return "0 dB";
  return `${r > 0 ? "+" : ""}${r} dB`;
}

/** Slider fill percentage for CSS background gradient. */
export function sliderFillPercent(gain: number, dbMax = OUTPUT_DB_MAX): number {
  const pos = gainToSlider(gain, dbMax);
  return ((pos - MUTE_POS) / (dbMax - MUTE_POS)) * 100;
}

const METER_DBFS_MIN = -60;

/** Input level (dBFS) -> meter width in percent; -60 dBFS is empty. */
export function meterDbFsToPercent(dbFs: number): number {
  const clamped = Math.max(METER_DBFS_MIN, Math.min(0, dbFs));
  return ((clamped - METER_DBFS_MIN) / (0 - METER_DBFS_MIN)) * 100;
}

export function formatDbFs(dbFs: number): string {
  if (!Number.isFinite(dbFs) || dbFs <= METER_DBFS_MIN) return "-inf dBFS";
  if (Math.abs(dbFs) < 0.05) return "0.0 dBFS";
  return `${dbFs.toFixed(1)} dBFS`;
}
