import { useCallback, useEffect, useState } from "react";

type UseAudioDevicesOptions = {
  setSelectedInputDeviceId: React.Dispatch<React.SetStateAction<string>>;
  setSelectedOutputDeviceId: React.Dispatch<React.SetStateAction<string>>;
};

export type UseAudioDevicesResult = {
  inputDevices: MediaDeviceInfo[];
  outputDevices: MediaDeviceInfo[];
  refreshAudioDevices: () => Promise<void>;
};

export function useAudioDevices({
  setSelectedInputDeviceId,
  setSelectedOutputDeviceId,
}: UseAudioDevicesOptions): UseAudioDevicesResult {
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);

  const refreshAudioDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    setInputDevices(inputs);
    setOutputDevices(outputs);
    setSelectedInputDeviceId((prev) => {
      if (prev && inputs.some((d) => d.deviceId === prev)) return prev;
      return inputs[0]?.deviceId || "";
    });
    setSelectedOutputDeviceId((prev) => {
      if (prev && outputs.some((d) => d.deviceId === prev)) return prev;
      return "";
    });
  }, [setSelectedInputDeviceId, setSelectedOutputDeviceId]);

  useEffect(() => {
    void refreshAudioDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshAudioDevices);
    return () =>
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        refreshAudioDevices,
      );
  }, [refreshAudioDevices]);

  return { inputDevices, outputDevices, refreshAudioDevices };
}
