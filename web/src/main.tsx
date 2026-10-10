import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ApiBaseUrlProvider } from "@kesher/client-core";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApiBaseUrlProvider>
      <App />
    </ApiBaseUrlProvider>
  </React.StrictMode>
);

// Service worker (public/sw.js, network first) for the installed PWA. Not on
// localhost, where it only adds certificate noise during development.
const isLocalhost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";
if (import.meta.env.PROD && "serviceWorker" in navigator && !isLocalhost) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(console.error);
  });
}
