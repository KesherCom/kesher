import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampAudioGateThresholdDb,
  clampInputGainValue,
  clampOutputGainValue,
  defaultAdminPin,
  favoritesStorageKey,
  type FavoriteSettings,
  globalSettingsStorageKey,
  type GlobalSettings,
  hasStoredSessionSettings,
  keyboardShortcutsStorageKey,
  type KeyboardShortcutSettings,
  loadFavoriteSettings,
  loadGlobalSettings,
  loadKeyboardShortcuts,
  loadSessionSettings,
} from "../app/settings";

const defaultInputGainDeviceKey = "__default__";

function inputGainDeviceKey(deviceId: string): string {
  return deviceId || defaultInputGainDeviceKey;
}

export type UseSettingsResult = {
  // Session identity
  username: string;
  setUsername: (v: string) => void;
  roleId: string;
  setRoleID: (v: string) => void;
  hadStoredSessionSettings: boolean;

  // Global settings
  selectedInputDeviceId: string;
  setSelectedInputDeviceId: React.Dispatch<React.SetStateAction<string>>;
  selectedInputDeviceIdRef: React.MutableRefObject<string>;
  selectedOutputDeviceId: string;
  setSelectedOutputDeviceId: React.Dispatch<React.SetStateAction<string>>;
  selectedOutputDeviceIdRef: React.MutableRefObject<string>;
  enableDirectPpt: boolean;
  setEnableDirectPpt: (v: boolean) => void;
  enableDirectTabs: boolean;
  setEnableDirectTabs: (v: boolean) => void;
  swapPttAndReplyButtons: boolean;
  setSwapPttAndReplyButtons: (v: boolean) => void;
  enableBackgroundAudioRecovery: boolean;
  setEnableBackgroundAudioRecovery: (v: boolean) => void;
  keepScreenAwake: boolean;
  setKeepScreenAwake: (v: boolean) => void;
  showVolumeControls: boolean;
  setShowVolumeControls: (v: boolean) => void;
  audioGateEnabled: boolean;
  setAudioGateEnabled: (v: boolean) => void;
  audioGateThresholdDb: number;
  setAudioGateThresholdDb: (v: number) => void;
  inputGainByDeviceId: Record<string, number>;
  setInputGainByDeviceId: React.Dispatch<
    React.SetStateAction<Record<string, number>>
  >;
  inputGainByDeviceIdRef: React.MutableRefObject<Record<string, number>>;
  roomGainById: Record<string, number>;
  setRoomGainById: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  roomGainByIdRef: React.MutableRefObject<Record<string, number>>;
  directGainByUserId: Record<string, number>;
  setDirectGainByUserId: React.Dispatch<
    React.SetStateAction<Record<string, number>>
  >;
  directGainByUserIdRef: React.MutableRefObject<Record<string, number>>;

  // Favorites
  pinnedRoomIds: string[];
  setPinnedRoomIds: React.Dispatch<React.SetStateAction<string[]>>;
  pinnedUserIds: string[];
  setPinnedUserIds: React.Dispatch<React.SetStateAction<string[]>>;
  showPinnedOnly: boolean;
  setShowPinnedOnly: (v: boolean) => void;

  // Keyboard shortcuts
  keyboardShortcuts: KeyboardShortcutSettings;
  setKeyboardShortcuts: React.Dispatch<
    React.SetStateAction<KeyboardShortcutSettings>
  >;

  // Admin PIN guard (runtime only, not persisted)
  adminPinGuard: string;
  setAdminPinGuard: (v: string) => void;

  // Stable gain callbacks
  onRoomGainChange: (roomId: string, gain: number) => void;
  onDirectGainChange: (userId: string, gain: number) => void;
  onInputGainChange: (deviceId: string, gain: number) => void;

  // Derived / computed
  selectedInputGainFor: (deviceId: string) => number;
};

export function useSettings(): UseSettingsResult {
  const initialSessionSettings = loadSessionSettings();
  const initialGlobalSettings = loadGlobalSettings();
  const initialFavorites = loadFavoriteSettings();
  const initialKeyboardShortcuts = loadKeyboardShortcuts();
  const hadStoredSessionSettingsValue = hasStoredSessionSettings();

  // Session identity
  const [username, setUsername] = useState(initialSessionSettings.username);
  const [roleId, setRoleID] = useState(initialSessionSettings.roleId);

  // Global settings
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState(
    initialGlobalSettings.selectedInputDeviceId,
  );
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState(
    initialGlobalSettings.selectedOutputDeviceId,
  );
  const [enableDirectPpt, setEnableDirectPpt] = useState(
    initialGlobalSettings.enableDirectPpt,
  );
  const [enableDirectTabs, setEnableDirectTabs] = useState(
    initialGlobalSettings.enableDirectTabs,
  );
  const [swapPttAndReplyButtons, setSwapPttAndReplyButtons] = useState(
    initialGlobalSettings.swapPttAndReplyButtons,
  );
  const [enableBackgroundAudioRecovery, setEnableBackgroundAudioRecovery] =
    useState(initialGlobalSettings.enableBackgroundAudioRecovery);
  const [keepScreenAwake, setKeepScreenAwake] = useState(
    initialGlobalSettings.keepScreenAwake,
  );
  const [showVolumeControls, setShowVolumeControls] = useState(
    initialGlobalSettings.showVolumeControls,
  );
  const [audioGateEnabled, setAudioGateEnabled] = useState(
    initialGlobalSettings.audioGateEnabled,
  );
  const [audioGateThresholdDb, setAudioGateThresholdDb] = useState(
    initialGlobalSettings.audioGateThresholdDb,
  );
  const [inputGainByDeviceId, setInputGainByDeviceId] = useState<
    Record<string, number>
  >(initialGlobalSettings.inputGainByDeviceId ?? {});
  const [roomGainById, setRoomGainById] = useState<Record<string, number>>(
    initialGlobalSettings.roomGainById,
  );
  const [directGainByUserId, setDirectGainByUserId] = useState<
    Record<string, number>
  >(initialGlobalSettings.directGainByUserId);

  // Favorites
  const [pinnedRoomIds, setPinnedRoomIds] = useState<string[]>(
    initialFavorites.pinnedRoomIds,
  );
  const [pinnedUserIds, setPinnedUserIds] = useState<string[]>(
    initialFavorites.pinnedUserIds,
  );
  const [showPinnedOnly, setShowPinnedOnly] = useState<boolean>(
    initialFavorites.showPinnedOnly,
  );

  // Keyboard shortcuts
  const [keyboardShortcuts, setKeyboardShortcuts] =
    useState<KeyboardShortcutSettings>(initialKeyboardShortcuts);

  // Admin PIN guard
  const [adminPinGuard, setAdminPinGuard] = useState<string>(defaultAdminPin);

  // Refs for stable access inside callbacks / effects
  const selectedInputDeviceIdRef = useRef(
    initialGlobalSettings.selectedInputDeviceId,
  );
  const selectedOutputDeviceIdRef = useRef(
    initialGlobalSettings.selectedOutputDeviceId,
  );
  const inputGainByDeviceIdRef = useRef(
    initialGlobalSettings.inputGainByDeviceId ?? {},
  );
  const roomGainByIdRef = useRef(initialGlobalSettings.roomGainById);
  const directGainByUserIdRef = useRef(
    initialGlobalSettings.directGainByUserId,
  );

  // Sync refs
  useEffect(() => {
    selectedInputDeviceIdRef.current = selectedInputDeviceId;
  }, [selectedInputDeviceId]);
  useEffect(() => {
    selectedOutputDeviceIdRef.current = selectedOutputDeviceId;
  }, [selectedOutputDeviceId]);
  useEffect(() => {
    inputGainByDeviceIdRef.current = inputGainByDeviceId;
  }, [inputGainByDeviceId]);
  useEffect(() => {
    roomGainByIdRef.current = roomGainById;
  }, [roomGainById]);
  useEffect(() => {
    directGainByUserIdRef.current = directGainByUserId;
  }, [directGainByUserId]);

  // Persistence – global settings
  useEffect(() => {
    localStorage.setItem(
      globalSettingsStorageKey,
      JSON.stringify({
        selectedInputDeviceId,
        selectedOutputDeviceId,
        enableDirectPpt,
        enableDirectTabs,
        swapPttAndReplyButtons,
        enableBackgroundAudioRecovery,
        keepScreenAwake,
        showVolumeControls,
        audioGateEnabled,
        audioGateThresholdDb,
        inputGainByDeviceId,
        roomGainById,
        directGainByUserId,
      } satisfies GlobalSettings),
    );
  }, [
    selectedInputDeviceId,
    selectedOutputDeviceId,
    enableDirectPpt,
    enableDirectTabs,
    swapPttAndReplyButtons,
    enableBackgroundAudioRecovery,
    keepScreenAwake,
    showVolumeControls,
    audioGateEnabled,
    audioGateThresholdDb,
    inputGainByDeviceId,
    roomGainById,
    directGainByUserId,
  ]);

  // Persistence – favorites
  useEffect(() => {
    localStorage.setItem(
      favoritesStorageKey,
      JSON.stringify({
        pinnedRoomIds,
        pinnedUserIds,
        showPinnedOnly,
      } satisfies FavoriteSettings),
    );
  }, [pinnedRoomIds, pinnedUserIds, showPinnedOnly]);

  // Persistence – keyboard shortcuts
  useEffect(() => {
    localStorage.setItem(
      keyboardShortcutsStorageKey,
      JSON.stringify(keyboardShortcuts),
    );
  }, [keyboardShortcuts]);

  // Stable gain callbacks
  const onRoomGainChange = useCallback((roomId: string, gain: number) => {
    setRoomGainById((prev) => ({
      ...prev,
      [roomId]: clampOutputGainValue(gain),
    }));
  }, []);

  const onDirectGainChange = useCallback((userId: string, gain: number) => {
    setDirectGainByUserId((prev) => ({
      ...prev,
      [userId]: clampOutputGainValue(gain),
    }));
  }, []);

  const onInputGainChange = useCallback((deviceId: string, gain: number) => {
    const key = inputGainDeviceKey(deviceId);
    setInputGainByDeviceId((prev) => ({
      ...prev,
      [key]: clampInputGainValue(gain),
    }));
  }, []);

  const selectedInputGainFor = useCallback(
    (deviceId: string): number => {
      return clampInputGainValue(
        inputGainByDeviceIdRef.current[inputGainDeviceKey(deviceId)] ?? 1,
      );
    },
    // inputGainByDeviceIdRef is stable; effect keeps it fresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    username,
    setUsername,
    roleId,
    setRoleID,
    hadStoredSessionSettings: hadStoredSessionSettingsValue,

    selectedInputDeviceId,
    setSelectedInputDeviceId,
    selectedInputDeviceIdRef,
    selectedOutputDeviceId,
    setSelectedOutputDeviceId,
    selectedOutputDeviceIdRef,
    enableDirectPpt,
    setEnableDirectPpt,
    enableDirectTabs,
    setEnableDirectTabs,
    swapPttAndReplyButtons,
    setSwapPttAndReplyButtons,
    enableBackgroundAudioRecovery,
    setEnableBackgroundAudioRecovery,
    keepScreenAwake,
    setKeepScreenAwake,
    showVolumeControls,
    setShowVolumeControls,
    audioGateEnabled,
    setAudioGateEnabled,
    audioGateThresholdDb,
    setAudioGateThresholdDb: (value: number) =>
      setAudioGateThresholdDb(clampAudioGateThresholdDb(value)),
    inputGainByDeviceId,
    setInputGainByDeviceId,
    inputGainByDeviceIdRef,
    roomGainById,
    setRoomGainById,
    roomGainByIdRef,
    directGainByUserId,
    setDirectGainByUserId,
    directGainByUserIdRef,

    pinnedRoomIds,
    setPinnedRoomIds,
    pinnedUserIds,
    setPinnedUserIds,
    showPinnedOnly,
    setShowPinnedOnly,

    keyboardShortcuts,
    setKeyboardShortcuts,

    adminPinGuard,
    setAdminPinGuard,

    onRoomGainChange,
    onDirectGainChange,
    onInputGainChange,
    selectedInputGainFor,
  };
}
