import type {
  StreamDeckButtonControlDefinition,
  StreamDeckWeb,
} from "@elgato-stream-deck/webhid";
import type { StreamDeckButtonConfig, StreamDeckSettings } from "../types";

const defaultBackground = "#182028";
const defaultForeground = "#eef4ff";
const defaultAccent = "#7fb2ff";
const defaultMuted = "rgba(238, 244, 255, 0.7)";
const unassignedBackground = "#000000";

const actionLabels: Record<string, string> = {
  none: "unassigned",
  ptt_room: "PTT",
  direct_role: "role",
  direct_user: "direct",
  reply_to_caller: "reply",
  broadcast_ptt: "broadcast",
  mute_toggle: "mute",
  volume_delta: "volume",
};

const actionBadges: Record<string, string> = {
  none: "",
  ptt_room: "PTT",
  direct_role: "ROLE",
  direct_user: "DIRECT",
  reply_to_caller: "REPLY",
  broadcast_ptt: "CAST",
  mute_toggle: "MUTE",
  volume_delta: "VOL",
};

export function getStreamDeckPageButtons(
  settings: StreamDeckSettings,
): StreamDeckButtonConfig[] {
  const page = settings.pages.find((entry) => entry.page === settings.selectedPage);
  return [...(page?.buttons ?? [])].sort((left, right) => left.index - right.index);
}

function normalizeHexColor(input?: string): string {
  const value = input?.trim() ?? "";
  if (!value) return defaultBackground;
  const short = /^#([0-9a-f]{3})$/i.exec(value);
  if (short) {
    const [, rgb] = short;
    return `#${rgb[0]}${rgb[0]}${rgb[1]}${rgb[1]}${rgb[2]}${rgb[2]}`.toLowerCase();
  }
  const long = /^#([0-9a-f]{6})$/i.exec(value);
  if (long) {
    return `#${long[1].toLowerCase()}`;
  }
  return defaultBackground;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(hex);
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function mixColors(hex: string, target: string, amount: number): string {
  const sourceRgb = hexToRgb(hex);
  const targetRgb = hexToRgb(target);
  const mix = (left: number, right: number) =>
    Math.round(left + (right - left) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(sourceRgb.r, targetRgb.r)}${mix(sourceRgb.g, targetRgb.g)}${mix(sourceRgb.b, targetRgb.b)}`;
}

function getRelativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const toLinear = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.04045
      ? srgb / 12.92
      : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function getReadableTextColor(background: string): string {
  return getRelativeLuminance(background) > 0.42 ? "#091019" : defaultForeground;
}

function getActionAccent(actionType?: string): string {
  switch (actionType) {
    case "ptt_room":
      return "#00a8ff";
    case "direct_role":
    case "direct_user":
      return "#1fd18b";
    case "reply_to_caller":
      return "#ffb84d";
    case "broadcast_ptt":
      return "#ff6b4a";
    case "mute_toggle":
      return "#f94144";
    case "volume_delta":
      return "#8a7dff";
    default:
      return defaultAccent;
  }
}

function getDisplayLabel(button: StreamDeckButtonConfig): string {
  const actionType = button.action?.type ?? "none";
  if (button.label?.trim()) return button.label.trim();
  if (actionType === "reply_to_caller") return "Reply";
  if (actionType === "none") return "";
  return actionType.replace(/_/g, " ");
}

function getSubtitle(button: StreamDeckButtonConfig): string {
  const actionType = button.action?.type ?? "none";
  return actionLabels[actionType] ?? actionType;
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = word;
    } else {
      lines.push(word);
      current = "";
    }

    if (lines.length === maxLines - 1) {
      break;
    }
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  const result = lines.slice(0, maxLines);
  if (result.length === maxLines && words.join(" ") !== result.join(" ")) {
    result[result.length - 1] = `${result[result.length - 1].slice(0, Math.max(0, result[result.length - 1].length - 1))}…`;
  }
  return result;
}

function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  initialSize: number,
  weight: number,
): number {
  let size = initialSize;
  while (size > 12) {
    ctx.font = `${weight} ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) {
      return size;
    }
    size -= 1;
  }
  return size;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
}

function createButtonCanvas(
  control: StreamDeckButtonControlDefinition,
  button: StreamDeckButtonConfig,
  pressed: boolean,
): HTMLCanvasElement | null {
  if (control.feedbackType !== "lcd") {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = control.pixelSize.width;
  canvas.height = control.pixelSize.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const actionType = button.action?.type ?? "none";
  const isUnassigned = actionType === "none";
  const accent = getActionAccent(actionType);
  const background = isUnassigned
    ? unassignedBackground
    : normalizeHexColor(button.color || mixColors(accent, defaultBackground, 0.84));
  const fill = pressed ? mixColors(background, "#ffffff", 0.25) : background;
  const stroke = isUnassigned
    ? pressed
      ? "rgba(255,255,255,0.2)"
      : "rgba(255,255,255,0.08)"
    : pressed
      ? mixColors(accent, "#ffffff", 0.45)
      : mixColors(accent, "#ffffff", 0.12);
  const radius = Math.max(10, Math.round(canvas.width * 0.14));
  const textColor = getReadableTextColor(fill);
  const subTextColor =
    textColor === defaultForeground
      ? defaultMuted
      : "rgba(9, 16, 25, 0.64)";
  const badgeText = actionBadges[actionType] ?? "KEY";
  const cardX = 6;
  const cardY = 6;
  const cardWidth = canvas.width - 12;
  const cardHeight = canvas.height - 12;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (isUnassigned) {
    ctx.fillStyle = "#000000";
  } else {
    const outerGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    outerGradient.addColorStop(0, mixColors(background, "#05070a", 0.9));
    outerGradient.addColorStop(1, "#020304");
    ctx.fillStyle = outerGradient;
  }
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.shadowColor = isUnassigned
    ? "rgba(255,255,255,0.05)"
    : pressed
      ? `${accent}88`
      : `${accent}33`;
  ctx.shadowBlur = isUnassigned ? 0 : pressed ? 16 : 8;
  roundedRect(ctx, cardX, cardY, cardWidth, cardHeight, radius);
  const fillGradient = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardHeight);
  fillGradient.addColorStop(0, isUnassigned ? "#050505" : mixColors(fill, "#ffffff", 0.04));
  fillGradient.addColorStop(0.58, fill);
  fillGradient.addColorStop(1, isUnassigned ? "#000000" : mixColors(fill, "#05070a", 0.12));
  ctx.fillStyle = fillGradient;
  ctx.fill();
  ctx.restore();

  roundedRect(ctx, cardX, cardY, cardWidth, cardHeight, radius);
  if (!isUnassigned) {
    const gloss = ctx.createLinearGradient(0, cardY, 0, cardY + cardHeight * 0.42);
    gloss.addColorStop(0, "rgba(255,255,255,0.08)");
    gloss.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gloss;
    ctx.fill();
  }

  roundedRect(ctx, cardX, cardY, cardWidth, cardHeight, radius);
  ctx.lineWidth = pressed ? 4 : 2;
  ctx.strokeStyle = stroke;
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (!isUnassigned && badgeText) {
    const badgeWidth = Math.min(
      cardWidth * 0.4,
      Math.max(36, badgeText.length * 10 + 16),
    );
    const badgeHeight = Math.round(canvas.height * 0.14);
    roundedRect(ctx, 12, 12, badgeWidth, badgeHeight, badgeHeight / 2);
    ctx.fillStyle = mixColors(accent, "#081018", 0.34);
    ctx.fill();

    ctx.font = `800 ${Math.max(9, Math.round(canvas.width * 0.07))}px sans-serif`;
    ctx.fillStyle = defaultForeground;
    ctx.fillText(badgeText, 12 + badgeWidth / 2, 12 + badgeHeight / 2 + 1);
  }

  const label = getDisplayLabel(button);
  if (!isUnassigned && label) {
    const labelFont = fitText(
      ctx,
      label,
      canvas.width - 28,
      Math.max(16, Math.round(canvas.width * 0.14)),
      800,
    );
    ctx.fillStyle = textColor;
    ctx.font = `800 ${labelFont}px sans-serif`;
    const labelLines = wrapLines(ctx, label, canvas.width - 28, 2);

    const labelLineHeight = Math.round(labelFont * 1.06);
    const labelStartY =
      Math.round(canvas.height * 0.56) -
      ((labelLines.length - 1) * labelLineHeight) / 2;
    labelLines.forEach((line, index) => {
      ctx.fillText(line, canvas.width / 2, labelStartY + index * labelLineHeight);
    });

    const footer = getSubtitle(button);
    ctx.font = `700 ${Math.max(10, Math.round(canvas.width * 0.072))}px sans-serif`;
    ctx.fillStyle = subTextColor;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(footer, canvas.width / 2, canvas.height - 14);
  }

  return canvas;
}

export async function renderStreamDeckButton(
  deck: StreamDeckWeb,
  control: StreamDeckButtonControlDefinition,
  button: StreamDeckButtonConfig,
  pressed: boolean,
): Promise<void> {
  if (control.feedbackType === "none") {
    return;
  }

  if (control.feedbackType === "rgb") {
    const isUnassigned = (button.action?.type ?? "none") === "none";
    const color = isUnassigned
      ? unassignedBackground
      : pressed
        ? mixColors(button.color ?? defaultBackground, "#ffffff", 0.2)
        : normalizeHexColor(button.color || mixColors(getActionAccent(button.action?.type), defaultBackground, 0.84));
    const { r, g, b } = hexToRgb(color);
    await deck.fillKeyColor(control.index, r, g, b);
    return;
  }

  const canvas = createButtonCanvas(control, button, pressed);
  if (!canvas) return;
  await deck.fillKeyCanvas(control.index, canvas);
}