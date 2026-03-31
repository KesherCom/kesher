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
