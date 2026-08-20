import { parseHTML } from "linkedom";

function clean(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function absoluteUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  try { return new URL(value, base).toString(); } catch { return null; }
}

export function extractReadableHtml(html: string, sourceUrl: string) {
  const { document } = parseHTML(html);
  document.querySelectorAll("script,style,noscript,template,iframe,form,nav,footer,aside,svg").forEach((node) => node.remove());
  const title = clean(
    document.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
    document.querySelector("h1")?.textContent || document.title,
  ) || "未命名文章";
  const author = clean(
    document.querySelector('meta[name="author"]')?.getAttribute("content") ||
    document.querySelector('[rel="author"]')?.textContent,
  );
  const description = clean(
    document.querySelector('meta[name="description"]')?.getAttribute("content") ||
    document.querySelector('meta[property="og:description"]')?.getAttribute("content"),
  );
  const canonical = absoluteUrl(document.querySelector('link[rel="canonical"]')?.getAttribute("href") || null, sourceUrl) || sourceUrl;
  const root = document.querySelector("article") || document.querySelector("main") || document.body;
  const candidates = Array.from(root.querySelectorAll("h1,h2,h3,p,blockquote,li"));
  const blocks = candidates.map((node, index) => ({
    ordinal: index,
    kind: /^H[1-3]$/.test(node.tagName) ? "heading" : node.tagName === "BLOCKQUOTE" ? "quote" : node.tagName === "LI" ? "list" : "paragraph",
    text: clean(node.textContent),
  })).filter((block) => block.text.length > 1);
  const deduped = blocks.filter((block, index) => index === 0 || block.text !== blocks[index - 1]?.text).slice(0, 10_000);
  const text = deduped.map((block) => block.text).join("\n\n");
  return { title, author: author || null, description: description || null, canonicalUrl: canonical, blocks: deduped, text };
}

function findJobPosting(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return record;
  const graph = record["@graph"];
  return graph ? findJobPosting(graph) : null;
}

export function extractJobHtml(html: string, sourceUrl: string) {
  const { document } = parseHTML(html);
  let structured: Record<string, unknown> | null = null;
  document.querySelectorAll('script[type="application/ld+json"]').forEach((node) => {
    if (structured) return;
    try { structured = findJobPosting(JSON.parse(node.textContent || "")); } catch { /* ignore malformed public metadata */ }
  });
  const metaTitle = clean(document.querySelector('meta[property="og:title"]')?.getAttribute("content") || document.title);
  const metaDescription = clean(document.querySelector('meta[property="og:description"]')?.getAttribute("content") || document.querySelector('meta[name="description"]')?.getAttribute("content"));
  const bodyText = clean((document.querySelector("main") || document.querySelector("article") || document.body).textContent).slice(0, 60_000);
  return { sourceUrl, metaTitle, metaDescription, structured, bodyText };
}
