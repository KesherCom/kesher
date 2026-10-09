import { useEffect, useState } from "react";
import type { KeyboardShortcutSettings } from "../../app/settings";
import type { Bootstrap } from "../../types";
import { Icon, type IconName } from "../Icon";
import { KeyboardShortcutsSettings } from "./KeyboardShortcutsSettings";
import { SettingSwitch, SettingsGroup } from "./SettingsParts";
import { SoundSettings, type SoundSettingsProps } from "./SoundSettings";
import {
  StreamDeckSettingsSection,
  type StreamDeckSettingsProps,
} from "./StreamDeckSettings";

type SectionId = "sound" | "controls" | "view" | "streamdeck" | "device";

const sections: Array<{
  id: SectionId;
  label: string;
  icon: IconName;
  intro: string;
}> = [
  {
    id: "sound",
    label: "Sound",
    icon: "speaker",
    intro: "Microphone and speaker of this device.",
  },
  {
    id: "controls",
    label: "Controls",
    icon: "keyboard",
    intro: "How you talk: buttons, cards and keyboard.",
  },
  {
    id: "view",
    label: "View",
    icon: "layout",
    intro: "What the station shows.",
  },
  {
    id: "streamdeck",
    label: "Stream Deck",
    icon: "grid",
    intro:
      "The Stream Deck belongs to this place: it keeps its layout, whoever is logged in here.",
  },
  {
    id: "device",
    label: "Device",
    icon: "device",
    intro: "Keeping this device ready while you work.",
  },
];

export type UserSettingsDialogProps = SoundSettingsProps &
  StreamDeckSettingsProps & {
    appData: Bootstrap;
    onClose: () => void;
    // Controls
    enableDirectPpt: boolean;
    onEnableDirectPptChange: (enabled: boolean) => void;
    swapPttAndReplyButtons: boolean;
    onSwapPttAndReplyButtonsChange: (enabled: boolean) => void;
    keyboardShortcuts: KeyboardShortcutSettings;
    onKeyboardShortcutsChange: (next: KeyboardShortcutSettings) => void;
    onRecordingShortcutChange: (recording: boolean) => void;
    // View
    showPinnedOnly: boolean;
    onShowPinnedOnlyChange: (value: boolean) => void;
    enableDirectTabs: boolean;
    onEnableDirectTabsChange: (enabled: boolean) => void;
    showVolumeControls: boolean;
    onShowVolumeControlsChange: (enabled: boolean) => void;
    // Device
    enableBackgroundAudioRecovery: boolean;
    onEnableBackgroundAudioRecoveryChange: (enabled: boolean) => void;
    keepScreenAwake: boolean;
    onKeepScreenAwakeChange: (enabled: boolean) => void;
    mediaSessionSupported: boolean;
    wakeLockSupported: boolean;
    wakeLockActive: boolean;
    isStandaloneDisplayMode: boolean;
  };

/**
 * User settings: a page per topic, navigation on the left (a list on
 * phones). Sound comes first because it is what people look for.
 */
export function UserSettingsDialog(props: UserSettingsDialogProps) {
  const { onClose } = props;
  const [section, setSection] = useState<SectionId>("sound");
  const current = sections.find((entry) => entry.id === section)!;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="k-dialog-backdrop" onClick={onClose}>
      <section
        className="k-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="k-dialog-header">
          <h3 id="settings-dialog-title">Settings</h3>
          <button
            type="button"
            className="k-icon-button"
            aria-label="Close settings"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="settings-dialog-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {sections.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`settings-nav-item ${entry.id === section ? "active" : ""}`}
                aria-current={entry.id === section ? "page" : undefined}
                onClick={() => setSection(entry.id)}
              >
                <Icon name={entry.icon} />
                {entry.label}
              </button>
            ))}
          </nav>
          <div className="settings-page">
            <h4 className="settings-page-title">{current.label}</h4>
            <p className="settings-page-intro">{current.intro}</p>
            {section === "sound" ? <SoundSettings {...props} /> : null}
            {section === "controls" ? <ControlsSettings {...props} /> : null}
            {section === "view" ? <ViewSettings {...props} /> : null}
            {section === "streamdeck" ? (
              <StreamDeckSettingsSection {...props} />
            ) : null}
            {section === "device" ? <DeviceSettings {...props} /> : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function ControlsSettings(props: UserSettingsDialogProps) {
  return (
    <>
      <SettingsGroup title="Talking">
        <SettingSwitch
          label="Hold a party line to talk on it"
          hint="Off: pressing a party line selects it, and you talk with the talk button."
          checked={props.enableDirectPpt}
          onChange={props.onEnableDirectPptChange}
        />
        <SettingSwitch
          label="Talk button first"
          hint="Puts the talk button before Reply in the bottom bar."
          checked={props.swapPttAndReplyButtons}
          onChange={props.onSwapPttAndReplyButtonsChange}
        />
      </SettingsGroup>
      <SettingsGroup title="Keyboard shortcuts">
        <KeyboardShortcutsSettings
          shortcuts={props.keyboardShortcuts}
          onShortcutsChange={props.onKeyboardShortcutsChange}
          onRecordingChange={props.onRecordingShortcutChange}
        />
      </SettingsGroup>
    </>
  );
}

function ViewSettings(props: UserSettingsDialogProps) {
  return (
    <SettingsGroup title="Station">
      <SettingSwitch
        label="Only favorites"
        hint="Show only the party lines and people you pinned."
        checked={props.showPinnedOnly}
        onChange={props.onShowPinnedOnlyChange}
      />
      <SettingSwitch
        label="People in tabs by role"
        hint="Group the people you can call directly into one tab per role."
        checked={props.enableDirectTabs}
        onChange={props.onEnableDirectTabsChange}
      />
      <SettingSwitch
        label="Volume on each card"
        hint="Show the dB value on each card; it opens a fader."
        checked={props.showVolumeControls}
        onChange={props.onShowVolumeControlsChange}
      />
    </SettingsGroup>
  );
}

function DeviceSettings(props: UserSettingsDialogProps) {
  const wakeLock = props.wakeLockSupported
    ? props.wakeLockActive
      ? "screen kept on"
      : "screen lock available"
    : "screen lock not supported";
  return (
    <>
      <SettingsGroup title="While connected">
        <SettingSwitch
          label="Keep audio running in the background"
          hint="Helps phones keep the sound alive when the screen is off or another app is open."
          checked={props.enableBackgroundAudioRecovery}
          onChange={props.onEnableBackgroundAudioRecoveryChange}
        />
        <SettingSwitch
          label="Keep the screen on"
          hint={
            props.wakeLockSupported
              ? "The device does not go to sleep while you are connected."
              : "This browser cannot keep the screen on."
          }
          checked={props.keepScreenAwake}
          disabled={!props.wakeLockSupported}
          onChange={props.onKeepScreenAwakeChange}
        />
        {!props.isStandaloneDisplayMode ? (
          <small className="k-setting-hint">
            On a phone, add Kesher to the home screen: it then runs more
            reliably in the background.
          </small>
        ) : null}
      </SettingsGroup>
      <SettingsGroup title="About">
        <div className="k-setting-diagnostics">
          <small>
            Version {props.appData.appVersion.version} · built{" "}
            {props.appData.appVersion.buildTimestamp}
          </small>
          <small>
            {props.isStandaloneDisplayMode ? "Installed app" : "Browser tab"}
            {" · "}
            {props.mediaSessionSupported
              ? "media keys supported"
              : "media keys not supported"}
            {" · "}
            {wakeLock}
          </small>
        </div>
      </SettingsGroup>
    </>
  );
}
