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
 * 改良: 実際にフォーム検索を行い、結果テーブルから厳密に抽出
 */
async function fetchTdnetByCode(page: import('playwright').Page, code: string, limit: number): Promise<NewsItem[]> {
  const base = 'https://www.release.tdnet.info/inbs/I_list_001_001.html';
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  const results: NewsItem[] = [];

  // 1) 可能なら検索フォームへ入力して実行（セレクタは変化しやすいので複数候補）
  const inputSelCandidates = ['input[name="code"]', 'input#code', 'input[type="search"]', 'form input[type="text"]'];
  let filled = false;
  for (const sel of inputSelCandidates) {
    const exists = await page.locator(sel).first().count();
    if (exists > 0) {
      await page.fill(sel, code);
      filled = true;
      break;
    }
  }
  if (filled) {
    // 検索ボタン候補
    const btnSelCandidates = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("検索")', 'button:has-text("Search")'];
    let clicked = false;
    for (const bsel of btnSelCandidates) {
      const count = await page.locator(bsel).first().count();
      if (count > 0) {
        await page.locator(bsel).first().click();
        clicked = true;
        break;
      }
    }
    if (clicked) {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(()=>{});
    }
  } else {
    // フォームが見当たらない場合はクエリ付きURLでフォールバック
    await page.goto(`https://www.release.tdnet.info/inbs/I_list_001_001.html?code=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded' }).catch(()=>{});
  }

  // 2) 結果テーブルから行を抽出（複数の候補セレクタを順番に試す）
  const tableCandidates = [
    'table#result', 'table.list', 'table', '.result table', '.list table', 'article table'
  ];
  let rowHandles: import('playwright').ElementHandle[] = [];
  for (const tsel of tableCandidates) {
    const table = page.locator(tsel).first();
    if (await table.count() > 0) {
      rowHandles = await table.locator('tr').elementHandles();
      if (rowHandles.length > 0) break;
    }
  }

  // 3) 行から a と日付を取り出して整形
  for (const tr of rowHandles) {
    if (results.length >= limit) break;

    const linkHandle = await tr.$('a[href]');
    if (!linkHandle) continue;
    const href = await linkHandle.getAttribute('href');
    const titleRaw = (await linkHandle.textContent()) || '';
    if (!href || !titleRaw.trim()) continue;

    const url = toAbs(page.url(), href);
    if (!/^https?:\/\//.test(url)) continue;

    // 近傍の日時セルを探索
    let publishedAt: string | null = null;
    const dateCell = await tr.$('td:has-text("202") , td:has-text("2024"), td:has-text("2025"), td[class*="date"], td[headers*="date"]');
    if (dateCell) {
      const dtRaw = ((await dateCell.textContent()) || '').trim();
      const iso = toISO(dtRaw);
      if (iso) publishedAt = iso;
    }

    const title = clip(titleRaw, 120);

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

  // 4) フォールバック（テーブルが取れない場合は広めの a 抽出→同ページ内の候補のみ）
  if (results.length === 0) {
    const anchors = await page.locator('a[href]').elementHandles();
    for (const a of anchors) {
      if (results.length >= limit) break;
      const href = await a.getAttribute('href');
      const text = ((await a.textContent()) || '').trim();
      if (!href || !text) continue;
      const abs = toAbs(page.url(), href);
      // TDnetの詳細ページらしいURLに限定（ヒューリスティック）
      if (!/\/inbs\/.+/i.test(abs)) continue;

      results.push({
        id: 'company-0',
        category: 'company',
        title: clip(text, 120),
        summary: '',
        source: `TDnet ${code}`,
        url: abs,
        publishedAt: null,
        tags: [],
        locale: 'ja',
        verified: true,
        thumbnail: '',
        type: 'disclosure',
        tickers: [`${code}.T`]
      });
    }
  }

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