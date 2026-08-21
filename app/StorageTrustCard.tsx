"use client";

import { useSyncExternalStore } from "react";

const subscribeToOrigin = () => () => undefined;
const readOrigin = () => window.location.origin;
const readServerOrigin = () => "";

export function StorageTrustCard() {
  const origin = useSyncExternalStore(
    subscribeToOrigin,
    readOrigin,
    readServerOrigin,
  );

  return (
    <section className="suite-storage" aria-labelledby="suite-storage-title">
      <div className="suite-storage-intro">
        <p className="suite-storage-kicker">资料归处</p>
        <h2 id="suite-storage-title">一处归属，三个空间各自收好。</h2>
        <p>
          这串完整地址，加上你现在使用的浏览器资料，共同决定眼前这一套本地资料。
          换主机名、端口或浏览器资料时，你会看到另一套；只要未被清理，原来的资料仍留在原处。
        </p>
      </div>

      <div className="suite-storage-origin" aria-label="当前资料所在的完整地址">
        <span>当前完整地址</span>
        <code dir="ltr" aria-live="polite">
          {origin || "正在确认当前地址…"}
        </code>
      </div>

      <details className="suite-storage-details">
        <summary>
          <span>清理、容量与整套搬家</span>
          <i aria-hidden="true">＋</i>
        </summary>
        <div className="suite-storage-grid">
          <article>
            <b>共同承受</b>
            <p>
              浏览器为这个完整地址留出的本地容量由三个空间共同使用。容量不足，或清除这个地址的资料，都可能同时影响三处。
            </p>
          </article>
          <article>
            <b>彼此独立</b>
            <p>
              职迹、拾词和适练的数据库、附件归处与完整备份各自独立，不会混在一起，也不能彼此替代。
            </p>
          </article>
          <article>
            <b>整套搬家</b>
            <p>
              想把整套资料带到另一个地址或浏览器资料，请分别从三个空间准备完整备份，一共 3 份。
            </p>
          </article>
        </div>
      </details>
    </section>
  );
}
