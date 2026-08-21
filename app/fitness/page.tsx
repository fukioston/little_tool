import type { Metadata } from "next";
import FitnessApp from "./FitnessApp";
import "./fitness.css";

export const metadata: Metadata = {
  title: "适练",
  description: "先认识真实场地与器材，再安排真正做得到的训练。",
};

export default function FitnessPage() {
  return <FitnessApp />;
}
