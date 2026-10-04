/**
 * 代码检索：分词 + 可增量更新的 BM25 倒排索引（纯内存、纯函数式接口之外只有索引自身的状态）。
 * 分词面向代码：标识符整体 + camelCase / snake_case 拆分后的子词，全部小写；中文按相邻双字。
 */

const K1 = 1.2;
const B = 0.75;

function splitIdentifier(word: string): string[] {
  const parts = word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_$-]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length >= 2);
  return parts.length > 1 ? parts : [];
}

/** 代码分词：标识符整体（小写）+ 子词 + 中文双字 */
export function codeTerms(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(/[A-Za-z_$][A-Za-z0-9_$]*|[0-9]{2,}/g) ?? []) {
    const lower = word.toLowerCase();
    if (lower.length >= 2) out.push(lower);
    out.push(...splitIdentifier(word));
  }
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

interface Doc {
  tf: Map<string, number>;
  length: number;
}

export interface ScoredDoc {
  id: string;
  score: number;
}

export class Bm25Index {
  private readonly docs = new Map<string, Doc>();
  private readonly df = new Map<string, number>();
  private totalLength = 0;

  get size(): number {
    return this.docs.size;
  }

  add(id: string, terms: readonly string[]): void {
    this.remove(id);
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.set(id, { tf, length: terms.length });
    this.totalLength += terms.length;
  }

  remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const t of doc.tf.keys()) {
      const n = (this.df.get(t) ?? 1) - 1;
      if (n <= 0) this.df.delete(t);
      else this.df.set(t, n);
    }
    this.totalLength -= doc.length;
    this.docs.delete(id);
  }

  /** accept：只给通过筛选的文档打分（在取 top N 之前筛选，避免筛选后结果变少） */
  search(queryTerms: readonly string[], limit: number, accept?: (id: string) => boolean): ScoredDoc[] {
    const n = this.docs.size;
    if (n === 0) return [];
    const avgdl = this.totalLength / n || 1;
    const unique = [...new Set(queryTerms)].filter((t) => this.df.has(t));
    if (unique.length === 0) return [];
    const idf = new Map(unique.map((t) => [t, Math.log(1 + (n - this.df.get(t)! + 0.5) / (this.df.get(t)! + 0.5))]));
    const scored: ScoredDoc[] = [];
    for (const [id, doc] of this.docs) {
      if (accept && !accept(id)) continue;
      let score = 0;
      for (const t of unique) {
        const f = doc.tf.get(t);
        if (!f) continue;
        score += idf.get(t)! * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / avgdl)));
      }
      if (score > 0) scored.push({ id, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
