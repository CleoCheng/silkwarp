import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SessionBar } from "./components/SessionBar";
import "./styles/index.css";

const isSessionBar = window.location.hash === "#session-bar";

if (isSessionBar) {
  // Transparent root so the floating bar can render over the remote window.
  document.body.classList.remove("bg-obsidian", "text-slate-100", "antialiased");
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  document.body.style.overflow = "hidden";
  document.documentElement.style.overflow = "hidden";
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isSessionBar ? <SessionBar /> : <App />}</React.StrictMode>,
);
