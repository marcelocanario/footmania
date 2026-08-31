import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { bootI18n } from "./i18n";
import "./theme.css";

void bootI18n().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
