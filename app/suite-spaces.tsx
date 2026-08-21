import type { ReactNode } from "react";

export type SuiteSpace = Readonly<{
  id: string;
  href: `/${string}`;
  glyph: string;
  eyebrow: string;
  name: string;
  tagline: string;
  description: string;
  cta: string;
  cardClassName: string;
  preview: ReactNode;
}>;

export const suiteSpaces = [
  {
    id: "career",
    href: "/career",
    glyph: "职",
    eyebrow: "CAREER",
    name: "职迹",
    tagline: "求职进度与面经",
    description: "把投递、沟通和面试放在一条安静的时间线上，只提示真正需要处理的下一步。",
    cta: "进入求职空间",
    cardClassName: "suite-career",
    preview: (
      <figure className="suite-career-figure" aria-hidden="true">
        <span><i />产品设计师</span>
        <span><i />后端工程师</span>
        <span><i />研究实习</span>
      </figure>
    ),
  },
  {
    id: "vocab",
    href: "/vocab",
    glyph: "词",
    eyebrow: "VOCAB",
    name: "拾词",
    tagline: "文章与播客语境",
    description: "在原文与声音里点开陌生词，用上下文理解，再回到第一次遇见它的地方复习。",
    cta: "进入学习空间",
    cardClassName: "suite-vocab",
    preview: (
      <figure className="suite-vocab-figure" aria-hidden="true">
        <small>IN CONTEXT</small>
        <p>Ideas become <mark>memorable</mark> when they stay connected to the story.</p>
      </figure>
    ),
  },
  {
    id: "fitness",
    href: "/fitness",
    glyph: "练",
    eyebrow: "FITNESS",
    name: "适练",
    tagline: "真实器材训练规划",
    description: "先录入这个健身房真正拥有的器材与重量，再规划现在确实做得到的训练。",
    cta: "进入训练空间",
    cardClassName: "suite-fitness",
    preview: (
      <figure className="suite-fitness-figure" aria-hidden="true">
        <span><b>深蹲架</b><small>已确认</small></span>
        <span><b>哑铃</b><small>5–30 kg</small></span>
        <span><b>绳索</b><small>常需替代</small></span>
      </figure>
    ),
  },
] as const satisfies readonly SuiteSpace[];
