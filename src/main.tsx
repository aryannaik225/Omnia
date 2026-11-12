import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/liquid-glass.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Omnia: #root element missing from index.html");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
