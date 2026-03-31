import type { StreamDeckButtonConfig, StreamDeckSettings } from "../types";

export function getStreamDeckPageButtons(
  settings: StreamDeckSettings,
): StreamDeckButtonConfig[] {
  const page = settings.pages.find((entry) => entry.page === settings.selectedPage);
  return [...(page?.buttons ?? [])].sort((left, right) => left.index - right.index);
}
