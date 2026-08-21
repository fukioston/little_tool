import Link from "next/link";

export const metadata = {
  description: "职迹、拾词、适练，以及之后属于你的本地优先私人空间。",
};

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
        <p>求职、学习与训练互不打扰。你的资料留在当前浏览器，真实记录不被分数和完成率取代。</p>
        <nav className="suite-shortcuts" aria-label="快速进入">
          <Link href="/career"><i>职</i><span>职迹</span></Link>
          <Link href="/vocab"><i>词</i><span>拾词</span></Link>
          <Link href="/fitness"><i>练</i><span>适练</span></Link>
        </nav>
      </section>
      <section className="suite-choices" aria-label="选择应用">
        <Link href="/career" className="suite-card suite-career">
          <header><span>CAREER</span><b>求职进度与面经</b></header>
          <div><h2>职迹</h2><p>把投递、沟通和面试放在一条安静的时间线上，只提示真正需要处理的下一步。</p></div>
          <figure className="suite-career-figure" aria-hidden="true"><span><i />产品设计师</span><span><i />后端工程师</span><span><i />研究实习</span></figure>
          <footer><span>进入求职空间</span><i>↗</i></footer>
        </Link>
        <Link href="/vocab" className="suite-card suite-vocab">
          <header><span>VOCAB</span><b>文章与播客语境</b></header>
          <div><h2>拾词</h2><p>在原文与声音里点开陌生词，用上下文理解，再回到第一次遇见它的地方复习。</p></div>
          <figure className="suite-vocab-figure" aria-hidden="true"><small>IN CONTEXT</small><p>Ideas become <mark>memorable</mark> when they stay connected to the story.</p></figure>
          <footer><span>进入学习空间</span><i>↗</i></footer>
        </Link>
        <Link href="/fitness" className="suite-card suite-fitness">
          <header><span>FITNESS</span><b>真实器材训练规划</b></header>
          <div><h2>适练</h2><p>先录入这个健身房真正拥有的器材与重量，再规划现在确实做得到的训练。</p></div>
          <figure className="suite-fitness-figure" aria-hidden="true"><span><b>深蹲架</b><small>已确认</small></span><span><b>哑铃</b><small>5–30 kg</small></span><span><b>绳索</b><small>常需替代</small></span></figure>
          <footer><span>进入训练空间</span><i>↗</i></footer>
        </Link>
      </section>
      <footer className="suite-trust"><span><i>SQLite</i><b>每个空间一份独立本地数据库</b></span><p>清除浏览器站点数据仍会影响资料；请使用各应用内的完整备份。</p></footer>
    </main>
  );
}
