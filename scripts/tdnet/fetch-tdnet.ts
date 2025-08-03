import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

type NewsItem = {
  id: string;
  category: 'company';
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string | null; // ISO8601
  tags: string[];
  locale: 'ja';
  verified: boolean;
  thumbnail: string;
  type?: string;         // 'disclosure'
  tickers?: string[];    // 例: ["7203.T"]
};

const NEWS_JSON = 'assets/data/news.json';
const TARGET_CODES = (process.env.TDNET_CODES || '7203,6758,9432')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const PER_CODE_LIMIT = parseInt(process.env.PER_CODE_LIMIT || '5', 10);
const CLEAN_MODE = (process.env.CLEAN_MODE || 'true').toLowerCase() !== 'false';

async function main() {
  assertExists(NEWS_JSON, `news.json が見つかりません: ${NEWS_JSON}`);

  // 事前クリーン（example.comや明らかなダミー等の除去はX側クリーンに委任、ここでは何もしない）

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const added: NewsItem[] = [];

  for (const code of TARGET_CODES) {
    const list = await fetchTdnetByCode(page, code, PER_CODE_LIMIT);
    added.push(...list);
  }

  await browser.close();

  if (added.length === 0) {
    console.log('TDnet: 追加候補が見つかりませんでした。');
    return;
  }

  const existing = JSON.parse(fs.readFileSync(NEWS_JSON, 'utf-8')) as any[];
  const existingUrls = new Set(existing.map(x => (x && x.url) || ''));

  const nextIdStart = calcNextIdStart(existing);
  let idCounter = nextIdStart;

  const toAppend: any[] = [];
  for (const n of added) {
    if (!n.url || existingUrls.has(n.url)) continue;
    toAppend.push({
      ...n,
      id: `company-${idCounter++}`
    });
  }

  if (toAppend.length === 0) {
    console.log('TDnet: 新規に追加できるURLはありません（既存と重複）。');
    return;
  }

  const merged = existing.concat(toAppend);
  fs.writeFileSync(NEWS_JSON, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`TDnet: news.json に ${toAppend.length} 件を追記しました。`);
}

function assertExists(p: string, msg?: string) {
  if (!fs.existsSync(p)) throw new Error(msg || `File not found: ${p}`);
}

function calcNextIdStart(items: any[]): number {
  // 既存 "company-N" と "sns-N" などが混在してもよいように、company-N の最大値を基準にする
  let max = 0;
  for (const it of items) {
    const m = typeof it?.id === 'string' ? it.id.match(/^company-(\d+)$/) : null;
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) max = Math.max(max, n);
    }
  }
  return max + 1;
}

/**
 * TDnet（適時開示）から銘柄コード別に最新 N 件取得
 * 備考: 公式サイト構造は変更される可能性があるため、セレクタは冗長にし過ぎない
 */
async function fetchTdnetByCode(page: import('playwright').Page, code: string, limit: number): Promise<NewsItem[]> {
  // JPX TDnet 検索ページ（コードで絞り込み、直近順）
  // 参考URL（将来変更の可能性あり）。構造変わった場合は適宜修正。
  const base = 'https://www.release.tdnet.info/inbs/I_list_001_001.html'; // 一覧トップ
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  // 画面内の検索UIがある場合にコード入力 → 検索。なければ銘柄別ページ探索に切替。
  // 汎用方針: コードテキストを含む行カードを抽出し、上位リンクから詳細へ
  // セレクタは変更されやすいので、まず記事テーブルを広く取る
  const results: NewsItem[] = [];

  // 直接検索クエリでのコードページ（フォールバック用）。非公開時は失敗可。
  // 代替: TDnetのJSON/CSVなどは利用せずスクレイプのみ
  try {
    // サイト構造によってはクエリ付きURLに飛ばす方式のほうが安定することがある
    // 例: 仮のパラメータ構造（実環境に合わせて変更が必要）
    // 実際にはサイトのフォームで submit して結果に遷移する実装が望ましい。
    await page.goto(`https://www.release.tdnet.info/inbs/I_list_001_001.html?code=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded' });
  } catch {}

  // article/行っぽい要素を広めに取得
  const rows = await page.locator('table, .list, .result, article, .news, .table').first().locator('a').elementHandles();

  for (const a of rows) {
    if (results.length >= limit) break;

    const href = await a.getAttribute('href');
    const text = ((await a.textContent()) || '').trim();
    if (!href || !text) continue;

    // 公開日時が近傍にある場合も多いが、まずはリンク先から拾う
    const url = toAbs(page.url(), href);
    if (!/^(https?:)?\/\//.test(url)) continue;

    // タイトルから不要な空白の正規化
    const title = clip(text, 120);

    // 詳細ページで日時を拾う（重い場合はスキップして一覧の近傍テキストから拾う）
    let publishedAt: string | null = null;
    try {
      const p2 = await page.context().newPage();
      await p2.goto(url, { waitUntil: 'domcontentloaded' });
      // timeタグ、または「公開日時」「提出日」などの近傍テキストを探索
      const timeEl = await p2.locator('time, .time, .date, .datetime, [datetime]').first();
      const have = await timeEl.count();
      if (have > 0) {
        const dt = (await timeEl.getAttribute('datetime')) || (await timeEl.textContent()) || '';
        const iso = toISO(dt);
        if (iso) publishedAt = iso;
      }
      await p2.close();
    } catch {
      // 無視して続行
    }

    results.push({
      id: 'company-0',
      category: 'company',
      title,
      summary: '',
      source: `TDnet ${code}`,
      url,
      publishedAt,
      tags: [],
      locale: 'ja',
      verified: true,
      thumbnail: '',
      type: 'disclosure',
      tickers: [`${code}.T`]
    });
  }

  // URL重複削除
  const uniq = uniqBy(results, r => r.url);
  console.log(`TDnet ${code}: 抽出 ${uniq.length} 件`);
  return uniq.slice(0, limit);
}

function uniqBy<T, K extends string | number>(arr: T[], key: (t: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const x of arr) {
    const k = key(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function clip(s: string, len: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > len ? t.slice(0, len - 1) + '…' : t;
}

function toAbs(baseUrl: string, href: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function toISO(raw: string): string | null {
  const s = (raw || '').trim();
  // すでにISOっぽい
  const isoTry = new Date(s);
  if (!isNaN(+isoTry)) return isoTry.toISOString();
  // yyyy/mm/dd hh:mm などを簡易パース
  const m = s.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    const hh = m[4] ? parseInt(m[4], 10) : 0;
    const mm = m[5] ? parseInt(m[5], 10) : 0;
    const dt = new Date(y, mo, d, hh, mm);
    if (!isNaN(+dt)) return dt.toISOString();
  }
  return null;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});