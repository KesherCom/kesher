// Main exports from kesher client-core

// App component
export { App } from "./App";
export { DesktopAppWrapper } from "./DesktopAppWrapper";

// Components
export { LoginView } from "./components/LoginView";
export { SimpleIntercomView } from "./components/SimpleIntercomView";
export { StationIntercomView } from "./components/StationIntercomView";
export { AdminShell } from "./components/admin/AdminShell";
export { ChatSignalPanel } from "./components/panels/ChatSignalPanel";
export { RealtimeEventsPanel } from "./components/panels/RealtimeEventsPanel";
export { DesktopServerSettings } from "./components/DesktopServerSettings";

// Hooks
export { useIntercomSession } from "./hooks/useIntercomSession";
export { useAudioDevices } from "./hooks/useAudioDevices";
export { useSettings } from "./hooks/useSettings";
export { useApiBaseUrl, ApiBaseUrlProvider } from "./hooks/useApiBaseUrl";
export { useNativeAudio } from "./hooks/useNativeAudio";

// Types & API
export * from "./types";
export * from "./api";

// Utilities
export * from "./lib/intercom";
export * from "./lib/users";
export * from "./lib/streamDeckLabels";
export * from "./lib/streamDeckDevTools";

// Styles
import "./styles.css";
