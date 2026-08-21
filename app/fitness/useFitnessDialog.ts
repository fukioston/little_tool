"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = "button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex='-1'])";

export function resolveFitnessDialogTabDestination(
  candidateCount: number,
  activeIndex: number,
  shiftKey: boolean,
): "dialog" | "first" | "last" | null {
  if (candidateCount === 0) return "dialog";
  if (activeIndex < 0 || activeIndex >= candidateCount) return shiftKey ? "last" : "first";
  if (shiftKey && activeIndex === 0) return "last";
  if (!shiftKey && activeIndex === candidateCount - 1) return "first";
  return null;
}

export function useFitnessDialog<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  initialFocus = FOCUSABLE,
): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = dialog.closest<HTMLElement>(".shilian");
    const changed: Array<{
      element: HTMLElement;
      hadInert: boolean;
      ariaHidden: string | null;
    }> = [];
    if (shell) {
      for (const child of Array.from(shell.children)) {
        if (
          !(child instanceof HTMLElement) ||
          child === dialog ||
          child.contains(dialog) ||
          /sl-(scrim|toast)/.test(child.className)
        ) continue;
        changed.push({
          element: child,
          hadInert: child.hasAttribute("inert"),
          ariaHidden: child.getAttribute("aria-hidden"),
        });
        child.setAttribute("inert", "");
        child.setAttribute("aria-hidden", "true");
      }
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTarget = dialog.querySelector<HTMLElement>(initialFocus) ?? dialog;
    const frame = requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
    const focusableCandidates = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => !element.hidden && element.getClientRects().length > 0);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusableCandidates();
      const activeElement = document.activeElement;
      const activeIndex = activeElement instanceof HTMLElement ? candidates.indexOf(activeElement) : -1;
      const destination = resolveFitnessDialogTabDestination(candidates.length, activeIndex, event.shiftKey);
      if (!destination) return;
      event.preventDefault();
      if (destination === "dialog") return void dialog.focus({ preventScroll: true });
      const first = candidates[0];
      const last = candidates.at(-1)!;
      (destination === "last" ? last : first).focus({ preventScroll: true });
    };
    const focusin = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || dialog.contains(target)) return;
      (focusableCandidates()[0] ?? dialog).focus({ preventScroll: true });
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin, true);
      document.body.style.overflow = previousOverflow;
      for (const { element, hadInert, ariaHidden } of changed) {
        if (!hadInert) element.removeAttribute("inert");
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      if (opener?.isConnected) requestAnimationFrame(() => opener.focus({ preventScroll: true }));
    };
  }, [initialFocus, open]);

  return dialogRef;
}
