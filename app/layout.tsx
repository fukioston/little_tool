import type { Metadata } from "next";
import "./globals.css";
import OfflineRegistration from "./OfflineRegistration";

export const metadata: Metadata = {
  title: { default: "私人工作台", template: "%s · 私人工作台" },
  description: "职迹与拾词，两款本地优先的私人智能应用。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN"><body>{children}<OfflineRegistration /></body></html>
  );
}
