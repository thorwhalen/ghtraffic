/**
 * Entry point: mount React, and install the one global "pressed" acknowledger.
 *
 * Why a global listener: on iOS, CSS `:active` does not fire reliably and
 * `:hover` sticks after a tap, so a press would show nothing. Setting
 * `data-pressed` on pointerdown (cleared on up/cancel/leave) gives every button
 * a visible pressed state within the same frame, styled in styles.css.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

function installPressFeedback() {
  let pressed: Element | null = null;
  const clear = () => {
    pressed?.removeAttribute("data-pressed");
    pressed = null;
  };
  document.addEventListener(
    "pointerdown",
    (e) => {
      const el = (e.target as Element | null)?.closest?.("button, [role=button], summary, select");
      if (!el) return;
      clear();
      pressed = el;
      el.setAttribute("data-pressed", "");
    },
    { passive: true },
  );
  for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, clear, { passive: true, capture: true });
  // pointerleave does not bubble; in the capture phase we see it for every element, so match the pressed one.
  document.addEventListener("pointerleave", (e) => e.target === pressed && clear(), { passive: true, capture: true });
  // Back/forward cache: a restored page must not show a stuck press.
  window.addEventListener("pageshow", (e) => e.persisted && clear());
}

installPressFeedback();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
