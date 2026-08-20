export const metadata = {
  title: "私人工作台",
  description: "职迹与拾词，两款本地优先的私人智能应用。",
};

export default function Home() {
  return (
    <main className="suite-home">
      <section className="suite-intro">
        <p className="suite-kicker">PRIVATE · LOCAL · YOURS</p>
        <h1>两个空间，<br />两种专注。</h1>
        <p>数据留在本地，智能只在需要时出现。</p>
      </section>
      <section className="suite-choices" aria-label="选择应用">
        <a href="/career" className="suite-card suite-career">
          <span>01 · 求职管理</span><h2>职迹</h2>
          <p>把每一次投递、沟通与面试，都变成下一步的线索。</p>
          <b>进入工作台 →</b>
        </a>
        <a href="/vocab" className="suite-card suite-vocab">
          <span>02 · 语境学习</span><h2>拾词</h2>
          <p>在文章和声音里遇见单词，也在原来的语境里记住它。</p>
          <b>开始沉浸 →</b>
        </a>
      </section>
    </main>
  );
}
