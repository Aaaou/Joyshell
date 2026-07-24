import { defaultTheme, applyTheme } from "@joyshell/ui";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./ui/App";
import "./assets/iconfont/iconfont.js";
import "./styles/base.css";
import "./styles/workspace.css";
import "./styles/overlays.css";

applyTheme(defaultTheme);

void document.fonts?.load('13px "Alimama FangYuanTi"').then(() => {
  console.info("[Joyshell] UI font loaded", document.fonts.check('13px "Alimama FangYuanTi"'));
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
