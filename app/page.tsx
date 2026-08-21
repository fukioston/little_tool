import Link from "next/link";
import { suiteSpaces } from "./suite-spaces";

export default function Home() {
  return (
    <main className="suite-home">
      <header className="suite-nav">
        <span className="suite-mark"><i>私</i><b>私人工作台</b></span>
        <p><i /><span>本地优先 · AI 仅在你主动使用时出现</span><b>本地优先</b></p>
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
      <footer className="suite-trust"><span><i>SQLite</i><b>每个空间一份独立本地数据库</b></span><p>清除浏览器站点数据仍会影响资料；请使用各应用内的完整备份。</p></footer>
    </main>
  );
}
