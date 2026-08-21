"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = "button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex='-1'])";

export function useOverlayDialog<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  initialFocus = FOCUSABLE,
): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = dialog.closest<HTMLElement>(".shici");
    const changed: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
    if (shell) {
      Array.from(shell.children).forEach((child) => {
        if (!(child instanceof HTMLElement) || child === dialog || child.contains(dialog) || /scrim/.test(child.className)) return;
        changed.push({ element: child, inert: child.inert, ariaHidden: child.getAttribute("aria-hidden") });
        child.inert = true;
        child.setAttribute("aria-hidden", "true");
      });
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTarget = dialog.querySelector<HTMLElement>(initialFocus) ?? dialog;
    const focusFrame = requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));

    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => !element.hidden && element.getClientRects().length > 0);
      if (!candidates.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", keydown, true);
      document.body.style.overflow = previousOverflow;
      changed.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      });
      if (opener?.isConnected) requestAnimationFrame(() => opener.focus({ preventScroll: true }));
    };
  }, [initialFocus, open]);

  return dialogRef;
}
