import type { Metadata } from "next";
import CareerApp from "./CareerApp";
import "./career.css";

export const metadata: Metadata = {
  title: "职迹",
  description: "私密、清晰的本地求职工作台。",
};

export default function CareerPage() {
  return <CareerApp />;
}
