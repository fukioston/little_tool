import Link from "next/link";
import { StorageTrustCard } from "./StorageTrustCard";
import { suiteSpaces } from "./suite-spaces";

export default function Home() {
  return (
    <main className="suite-home">
      <header className="suite-nav">
        <span className="suite-mark"><i>私</i><b>私人工作台</b></span>
        <p><i /><span>默认保存在本浏览器 · 主动使用 AI 时才发送该次所需的最少上下文</span><b>默认本地</b></p>
      </header>
      <section className="suite-intro">
        <p className="suite-kicker">PRIVATE · LOCAL · YOURS</p>
        <h1>你的空间，<br /><em>各自专注。</em></h1>
        <p>不同目标互不打扰。你的资料留在当前浏览器，真实记录不被分数和完成率取代。</p>
        <nav className="suite-shortcuts" aria-label="快速进入">
          {suiteSpaces.map((space) => (
            <Link href={space.href} key={space.id}>
              <i aria-hidden="true">{space.glyph}</i><span>{space.name}</span>
            </Link>
          ))}
        </nav>
      </section>
      <section className="suite-choices" aria-label="选择空间">
        {suiteSpaces.map((space) => (
          <Link
            href={space.href}
            className={`suite-card ${space.cardClassName}`}
            aria-label={`进入${space.name}空间`}
            key={space.id}
          >
            <header><span>{space.eyebrow}</span><b>{space.tagline}</b></header>
            <div><h2>{space.name}</h2><p>{space.description}</p></div>
            {space.preview}
            <footer><span>{space.cta}</span><i aria-hidden="true">↗</i></footer>
          </Link>
        ))}
      </section>
      <StorageTrustCard />
      <footer className="suite-trust"><span><i>LOCAL</i><b>三个空间各有自己的资料边界</b></span><p>资料默认保存在当前浏览器；只有你主动使用 AI 功能时，才会发送完成该次请求所需的最少上下文。清除站点数据仍会影响资料。</p></footer>
    </main>
  );
}
