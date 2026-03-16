import type {
  StreamDeckButtonControlDefinition,
  StreamDeckWeb,
} from "@elgato-stream-deck/webhid";
import type { StreamDeckButtonConfig, StreamDeckSettings } from "../types";

const defaultBackground = "#182028";
const defaultForeground = "#eef4ff";
const defaultMuted = "rgba(238, 244, 255, 0.7)";
const streamDeckCanvasBackground = "#0b1016";

type KeyPalette = {
  background: string;
  border: string;
  label: string;
  stripe?: string;
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
      return "#7fb2ff";
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
  return actionType === "none" ? "unassigned" : actionType;
}

function getDisplayTitle(button: StreamDeckButtonConfig): string {
  const label = getDisplayLabel(button) || `Button ${button.index + 1}`;
  return label.trim().toUpperCase();
}

function getButtonPalette(button: StreamDeckButtonConfig, pressed: boolean): KeyPalette {
  const actionType = button.action?.type ?? "none";
  if (button.color?.trim()) {
    const custom = normalizeHexColor(button.color);
    return {
      background: pressed ? mixColors(custom, "#ffffff", 0.08) : custom,
      border: pressed ? mixColors(custom, "#ffffff", 0.42) : mixColors(custom, "#ffffff", 0.22),
      label: getReadableTextColor(custom),
      stripe: mixColors(custom, "#ffffff", 0.32),
    };
  }

  switch (actionType) {
    case "broadcast_ptt":
      return {
        background: pressed ? "#ff1c1c" : "#ef1212",
        border: "#ff2d26",
        label: "#f7f7f7",
      };
    case "direct_role":
    case "direct_user":
      return {
        background: pressed ? "#3b3e44" : "#2f3238",
        border: "#ff2d26",
        label: "#f3f5f7",
      };
    case "ptt_room":
      return {
        background: pressed ? "#3d424a" : "#31363e",
        border: "#1b2026",
        label: "#f1f4f8",
        stripe: "#15c84b",
      };
    case "reply_to_caller":
      return {
        background: pressed ? "#4a4032" : "#3a3228",
        border: "#ffc067",
        label: "#f6f0e8",
      };
    case "mute_toggle":
      return {
        background: pressed ? "#4f2323" : "#3f1b1b",
        border: "#f84e4e",
        label: "#fff1f1",
      };
    case "volume_delta":
      return {
        background: pressed ? "#36324e" : "#2b2840",
        border: "#9d8cff",
        label: "#f2f0ff",
      };
    default:
      return {
        background: pressed ? "#2f3640" : "#242a31",
        border: "#1a1f26",
        label: "#edf2f8",
      };
  }
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

function drawIconHeadset(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  size: number,
  color: string,
) {
  const r = size * 0.35;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(3, Math.round(size * 0.06));
  ctx.beginPath();
  ctx.arc(centerX, centerY - size * 0.03, r, Math.PI * 1.1, Math.PI * 1.9);
  ctx.stroke();

  roundedRect(ctx, centerX - size * 0.35, centerY - size * 0.05, size * 0.13, size * 0.4, size * 0.06);
  ctx.fill();
  roundedRect(ctx, centerX + size * 0.22, centerY - size * 0.05, size * 0.13, size * 0.4, size * 0.06);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(centerX + size * 0.26, centerY + size * 0.33);
  ctx.lineTo(centerX + size * 0.48, centerY + size * 0.47);
  ctx.stroke();
  roundedRect(ctx, centerX + size * 0.44, centerY + size * 0.42, size * 0.2, size * 0.1, size * 0.05);
  ctx.fill();
  ctx.restore();
}

function drawIconMegaphone(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  size: number,
  color: string,
) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(3, Math.round(size * 0.05));

  roundedRect(ctx, centerX - size * 0.32, centerY + size * 0.04, size * 0.15, size * 0.22, size * 0.05);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(centerX - size * 0.16, centerY - size * 0.08);
  ctx.lineTo(centerX + size * 0.34, centerY - size * 0.24);
  ctx.lineTo(centerX + size * 0.34, centerY + size * 0.24);
  ctx.lineTo(centerX - size * 0.16, centerY + size * 0.08);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(centerX + size * 0.12, centerY - size * 0.13);
  ctx.lineTo(centerX + size * 0.12, centerY + size * 0.13);
  ctx.strokeStyle = mixColors(color, "#000000", 0.24);
  ctx.stroke();
  ctx.restore();
}

function drawIconCamera(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  size: number,
  color: string,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(3, Math.round(size * 0.05));

  roundedRect(ctx, centerX - size * 0.38, centerY - size * 0.16, size * 0.46, size * 0.34, size * 0.06);
  ctx.stroke();
  roundedRect(ctx, centerX - size * 0.02, centerY - size * 0.1, size * 0.34, size * 0.22, size * 0.04);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(centerX - size * 0.16, centerY + size * 0.01, size * 0.11, 0, Math.PI * 2);
  ctx.stroke();

  roundedRect(ctx, centerX - size * 0.27, centerY - size * 0.28, size * 0.12, size * 0.11, size * 0.03);
  ctx.fill();
  ctx.restore();
}

function drawIconMute(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  size: number,
  color: string,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(3, Math.round(size * 0.05));

  roundedRect(ctx, centerX - size * 0.1, centerY - size * 0.22, size * 0.2, size * 0.32, size * 0.08);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(centerX, centerY + size * 0.1);
  ctx.lineTo(centerX, centerY + size * 0.28);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(centerX - size * 0.18, centerY + size * 0.28);
  ctx.lineTo(centerX + size * 0.18, centerY + size * 0.28);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(centerX - size * 0.28, centerY - size * 0.3);
  ctx.lineTo(centerX + size * 0.28, centerY + size * 0.3);
  ctx.strokeStyle = "#ff5757";
  ctx.stroke();
  ctx.restore();
}

function drawIconVolume(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  size: number,
  color: string,
) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(3, Math.round(size * 0.05));

  ctx.beginPath();
  ctx.moveTo(centerX - size * 0.3, centerY - size * 0.1);
  ctx.lineTo(centerX - size * 0.12, centerY - size * 0.1);
  ctx.lineTo(centerX + size * 0.02, centerY - size * 0.24);
  ctx.lineTo(centerX + size * 0.02, centerY + size * 0.24);
  ctx.lineTo(centerX - size * 0.12, centerY + size * 0.1);
  ctx.lineTo(centerX - size * 0.3, centerY + size * 0.1);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.arc(centerX + size * 0.08, centerY, size * 0.18, -0.8, 0.8);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(centerX + size * 0.08, centerY, size * 0.3, -0.75, 0.75);
  ctx.stroke();
  ctx.restore();
}

function drawIconReply(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  size: number,
  color: string,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(3, Math.round(size * 0.05));
  ctx.beginPath();
  ctx.moveTo(centerX + size * 0.24, centerY - size * 0.2);
  ctx.lineTo(centerX - size * 0.08, centerY - size * 0.2);
  ctx.lineTo(centerX - size * 0.08, centerY - size * 0.32);
  ctx.lineTo(centerX - size * 0.34, centerY);
  ctx.lineTo(centerX - size * 0.08, centerY + size * 0.32);
  ctx.lineTo(centerX - size * 0.08, centerY + size * 0.2);
  ctx.lineTo(centerX + size * 0.24, centerY + size * 0.2);
  ctx.stroke();
  ctx.restore();
}

function drawActionIcon(
  ctx: CanvasRenderingContext2D,
  actionType: string,
  centerX: number,
  centerY: number,
  size: number,
  color: string,
) {
  switch (actionType) {
    case "ptt_room":
      drawIconHeadset(ctx, centerX, centerY, size, color);
      return;
    case "broadcast_ptt":
      drawIconMegaphone(ctx, centerX, centerY, size, color);
      return;
    case "direct_role":
    case "direct_user":
      drawIconCamera(ctx, centerX, centerY, size, color);
      return;
    case "reply_to_caller":
      drawIconReply(ctx, centerX, centerY, size, color);
      return;
    case "mute_toggle":
      drawIconMute(ctx, centerX, centerY, size, color);
      return;
    case "volume_delta":
      drawIconVolume(ctx, centerX, centerY, size, color);
      return;
    default:
      drawIconHeadset(ctx, centerX, centerY, size, color);
  }
}

function createButtonCanvasFromSize(
  width: number,
  height: number,
  button: StreamDeckButtonConfig,
  pressed: boolean,
): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const actionType = button.action?.type ?? "none";
  const accent = getActionAccent(actionType);
  const palette = getButtonPalette(button, pressed);
  const fill = palette.background;
  const stroke = pressed ? mixColors(palette.border, "#ffffff", 0.2) : palette.border;
  const radius = Math.max(10, Math.round(canvas.width * 0.12));
  const textColor = palette.label;
  const subTextColor = defaultMuted;
  const cardX = 7;
  const cardY = 7;
  const cardWidth = canvas.width - 14;
  const cardHeight = canvas.height - 14;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = streamDeckCanvasBackground;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.shadowColor = pressed ? "rgba(255, 56, 56, 0.35)" : `${accent}28`;
  ctx.shadowBlur = pressed ? 14 : 6;
  roundedRect(ctx, cardX, cardY, cardWidth, cardHeight, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();

  const innerTopGradient = ctx.createLinearGradient(0, cardY, 0, cardY + cardHeight * 0.75);
  innerTopGradient.addColorStop(0, "rgba(255,255,255,0.08)");
  innerTopGradient.addColorStop(1, "rgba(255,255,255,0)");
  roundedRect(ctx, cardX, cardY, cardWidth, cardHeight, radius);
  ctx.fillStyle = innerTopGradient;
  ctx.fill();

  roundedRect(ctx, cardX, cardY, cardWidth, cardHeight, radius);
  ctx.lineWidth = pressed ? 4 : 3;
  ctx.strokeStyle = stroke;
  ctx.stroke();

  if (pressed) {
    roundedRect(ctx, cardX - 1, cardY - 1, cardWidth + 2, cardHeight + 2, radius + 1);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 115, 115, 0.28)";
    ctx.stroke();
  }

  if (palette.stripe) {
    roundedRect(
      ctx,
      cardX + 2,
      cardY + cardHeight - Math.round(canvas.height * 0.1),
      cardWidth - 4,
      Math.round(canvas.height * 0.08),
      Math.max(4, Math.round(canvas.width * 0.03)),
    );
    ctx.fillStyle = palette.stripe;
    ctx.fill();
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const iconColor = mixColors(textColor, "#ffffff", 0.08);
  drawActionIcon(
    ctx,
    actionType,
    canvas.width / 2,
    canvas.height * 0.39,
    canvas.width * 0.64,
    iconColor,
  );

  const title = getDisplayTitle(button);
  if (title) {
    const labelFont = fitText(
      ctx,
      title,
      canvas.width - 24,
      Math.max(18, Math.round(canvas.width * 0.15)),
      800,
    );
    ctx.fillStyle = textColor;
    ctx.font = `800 ${labelFont}px sans-serif`;
    const labelLines = wrapLines(ctx, title, canvas.width - 24, 2);

    const labelLineHeight = Math.round(labelFont * 1.03);
    const labelStartY =
      Math.round(canvas.height * 0.77) -
      ((labelLines.length - 1) * labelLineHeight) / 2;
    labelLines.forEach((line, index) => {
      ctx.fillText(line, canvas.width / 2, labelStartY + index * labelLineHeight);
    });

    const footer = getSubtitle(button).toUpperCase();
    ctx.font = `700 ${Math.max(8, Math.round(canvas.width * 0.052))}px sans-serif`;
    ctx.fillStyle = subTextColor;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(footer, canvas.width / 2, canvas.height - 6);
  }

  return canvas;
}

export function createStreamDeckButtonPreviewDataUrl(
  button: StreamDeckButtonConfig,
  options?: { pressed?: boolean; width?: number; height?: number },
): string {
  const canvas = createButtonCanvasFromSize(
    options?.width ?? 96,
    options?.height ?? 96,
    button,
    options?.pressed ?? false,
  );
  return canvas?.toDataURL("image/png") ?? "";
}

function createButtonCanvas(
  control: StreamDeckButtonControlDefinition,
  button: StreamDeckButtonConfig,
  pressed: boolean,
): HTMLCanvasElement | null {
  if (control.feedbackType !== "lcd") {
    return null;
  }
  return createButtonCanvasFromSize(
    control.pixelSize.width,
    control.pixelSize.height,
    button,
    pressed,
  );
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
    const color = pressed
      ? mixColors(button.color ?? defaultBackground, "#ffffff", 0.2)
      : normalizeHexColor(button.color || defaultBackground);
    const { r, g, b } = hexToRgb(color);
    await deck.fillKeyColor(control.index, r, g, b);
    return;
  }

  const canvas = createButtonCanvas(control, button, pressed);
  if (!canvas) return;
  await deck.fillKeyCanvas(control.index, canvas);
}