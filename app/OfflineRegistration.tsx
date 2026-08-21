"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const SYNC_SUITE_ROUTES = "SYNC_SUITE_ROUTES";

export default function OfflineRegistration({ routes }: { routes: readonly string[] }) {
  const router = useRouter();

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let disposed = false;
    const offlineRoutes = [...new Set(["/", ...routes])];
    const syncRoutes = () => {
      const controller = navigator.serviceWorker.controller;
      if (!controller) return;
      controller.postMessage({
        type: SYNC_SUITE_ROUTES,
        routes: offlineRoutes,
      });
      routes.forEach((route) => router.prefetch(route));
    };
    const register = async () => {
      try {
        navigator.serviceWorker.addEventListener("controllerchange", syncRoutes);
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        await navigator.serviceWorker.ready;
        if (disposed) return;
        syncRoutes();
      } catch {
        // Offline support is progressive enhancement; the apps remain usable without it.
      }
    };

    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true });
    return () => {
      disposed = true;
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener("controllerchange", syncRoutes);
    };
  }, [router, routes]);
  return null;
}
