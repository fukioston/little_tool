import type { Metadata } from "next";
import VocabApp from "./VocabApp";
import "./vocab.css";

export const metadata: Metadata = {
  title: "拾词",
  description: "从英文文章与播客里，拾起真正属于语境的词。",
};

export default function VocabPage() {
  return <VocabApp />;
}
