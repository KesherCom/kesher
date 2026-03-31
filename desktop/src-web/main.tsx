import React from "react";
import ReactDOM from "react-dom/client";
import { DesktopAppWrapper, ApiBaseUrlProvider } from "@kesher/client-core";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApiBaseUrlProvider>
      <DesktopAppWrapper />
    </ApiBaseUrlProvider>
  </React.StrictMode>,
);
