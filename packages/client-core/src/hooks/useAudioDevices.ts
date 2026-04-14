import { useCallback, useEffect, useState } from "react";

type NativeAudioDevice = {
  id: string;
  name: string;
  kind: "audioinput" | "audiooutput";
};

type UseAudioDevicesOptions = {
  setSelectedInputDeviceId: React.Dispatch<React.SetStateAction<string>>;
  setSelectedOutputDeviceId: React.Dispatch<React.SetStateAction<string>>;
  isNative?: boolean;
  listNativeAudioDevices?: () => Promise<NativeAudioDevice[]>;
};

export type UseAudioDevicesResult = {
  inputDevices: MediaDeviceInfo[];
  outputDevices: MediaDeviceInfo[];
  refreshAudioDevices: () => Promise<void>;
};

export function useAudioDevices({
  setSelectedInputDeviceId,
  setSelectedOutputDeviceId,
  isNative,
  listNativeAudioDevices,
}: UseAudioDevicesOptions): UseAudioDevicesResult {
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);

  const mapNativeDevice = (d: NativeAudioDevice): MediaDeviceInfo =>
    ({
      deviceId: d.id,
      groupId: "",
      kind: d.kind,
      label: d.name,
      toJSON: () => ({
        deviceId: d.id,
        groupId: "",
        kind: d.kind,
        label: d.name,
      }),
    }) as MediaDeviceInfo;

  const refreshAudioDevices = useCallback(async () => {
    const devices =
      isNative && listNativeAudioDevices
        ? (await listNativeAudioDevices()).map(mapNativeDevice)
        : await navigator.mediaDevices.enumerateDevices();
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
  }, [
    isNative,
    listNativeAudioDevices,
    setSelectedInputDeviceId,
    setSelectedOutputDeviceId,
  ]);

  useEffect(() => {
    void refreshAudioDevices();
    if (isNative) return;
    navigator.mediaDevices.addEventListener("devicechange", refreshAudioDevices);
    return () =>
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        refreshAudioDevices,
      );
  }, [isNative, refreshAudioDevices]);

  return { inputDevices, outputDevices, refreshAudioDevices };
}
