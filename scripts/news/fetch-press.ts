import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

type PressItem = {
  id: string;
  category: 'market' | 'company';
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string | null; // ISO8601
  tags: string[];
  locale: 'ja';
  verified: boolean;
  thumbnail: string;
  type?: string;        // 例: 'macro' | 'companyNews' など
  tickers?: string[];   // 例: ["7203.T"]
};

// 収集対象（最初の実装はトップ/マーケット/日本株など汎用セレクタで抜き出す）
const TARGETS = [
  { name: 'Reuters Japan', base: 'https://jp.reuters.com/', pages: ['https://jp.reuters.com/'] },
  { name: 'Nikkei', base: 'https://www.nikkei.com/', pages: ['https://www.nikkei.com/'] },
  { name: 'Bloomberg Japan', base: 'https://www.bloomberg.co.jp/', pages: ['https://www.bloomberg.co.jp/'] },
];

const NEWS_JSON = 'assets/data/news.json';
const PER_SITE_LIMIT = parseInt(process.env.PRESS_PER_SITE_LIMIT || '10', 10);
const GLOBAL_LIMIT = parseInt(process.env.PRESS_GLOBAL_LIMIT || '50', 10);

async function main() {
  assertExists(NEWS_JSON, `news.json が見つかりません: ${NEWS_JSON}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const collected: PressItem[] = [];

  for (const site of TARGETS) {
    for (const url of site.pages) {
      if (collected.length >= GLOBAL_LIMIT) break;
      try {
        const list = await collectFromSite(page, site.name, site.base, url, PER_SITE_LIMIT);
        collected.push(...list);
      } catch (e) {
        console.warn(`収集失敗: ${site.name} ${url}`, e);
      }
    }
  }

  await browser.close();

  if (collected.length === 0) {
    console.log('press: 追加候補が見つかりませんでした。');
    return;
  }

  // 24hで絞る（サイト側で時刻不明の場合は除外）
  const within24h = collected.filter(it => {
    if (!it.publishedAt) return false;
    const d = new Date(it.publishedAt);
    if (Number.isNaN(+d)) return false;
    const diff = Date.now() - d.getTime();
    return diff >= 0 && diff <= 24 * 60 * 60 * 1000;
  });

  if (within24h.length === 0) {
    console.log('press: 24時間以内の記事が見つかりませんでした。');
    return;
  }

  // 既存との重複排除
  const existing = JSON.parse(fs.readFileSync(NEWS_JSON, 'utf-8')) as any[];
  const existingUrls = new Set(existing.map(x => (x && x.url) || ''));
  const nextIdStart = calcNextIdStart(existing, 'news');

  let idCounter = nextIdStart;
  const toAppend: any[] = [];
  for (const it of within24h) {
    if (!it.url || existingUrls.has(it.url)) continue;
    toAppend.push({
      ...it,
      id: `news-${idCounter++}`
    });
  }

  if (toAppend.length === 0) {
    console.log('press: 新規に追加できるURLはありません（既存と重複）。');
    return;
  }

  const merged = existing.concat(toAppend);
  fs.writeFileSync(NEWS_JSON, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`press: news.json に ${toAppend.length} 件を追記しました。`);
}

function assertExists(p: string, msg?: string) {
  if (!fs.existsSync(p)) throw new Error(msg || `File not found: ${p}`);
}

function calcNextIdStart(items: any[], prefix: string): number {
  // 既存 "prefix-N" の最大値+1を返す
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const it of items) {
    const m = typeof it?.id === 'string' ? it.id.match(re) : null;
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) max = Math.max(max, n);
    }
  }
  return max + 1;
}

async function collectFromSite(page: Page, siteName: string, base: string, url: string, perLimit: number): Promise<PressItem[]> {
  console.log(`収集: ${siteName} ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // リンク候補を広く収集（aタグ）
  const anchors = await page.locator('a[href]').elementHandles();

  type Raw = { href: string; title: string };

  const raw: Raw[] = [];
  for (const a of anchors) {
    if (raw.length >= perLimit * 5) break; // 取りすぎ防止（緩め）
    const href = await a.getAttribute('href');
    let title = ((await a.textContent()) || '').trim().replace(/\s+/g, ' ');
    if (!href) continue;
    const abs = toAbs(base, href);
    // ドメイン外や不要セクションを軽く除外（ヒューリスティック）
    if (!abs.startsWith(base)) continue;
    // タイトルが短すぎる/無意味な場合は除外
    if (!title || title.length < 6) continue;

    raw.push({ href: abs, title });
  }

  // 重複リンクの排除
  const uniqByHref = new Map<string, Raw>();
  for (const r of raw) {
    if (!uniqByHref.has(r.href)) uniqByHref.set(r.href, r);
  }

  // 各記事リンクに対して、詳細から日付を取得
  const items: PressItem[] = [];
  for (const r of uniqByHref.values()) {
    if (items.length >= perLimit) break;

    let publishedAt: string | null = null;
    let category: 'market' | 'company' = guessCategory(siteName, r.title, r.href);
    let type: string | undefined = guessType(r.title, r.href);

    try {
      const p2 = await page.context().newPage();
      await p2.goto(r.href, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      // 汎用的な時刻セレクタ候補
      const timeCandidates = [
        'time[datetime]', 'time',
        'meta[itemprop="datePublished"]',
        'meta[property="article:published_time"]',
        '.articleTime', '.time', '.date', '.datetime', 'span.date',
        'header time', 'article time'
      ];

      for (const sel of timeCandidates) {
        const loc = p2.locator(sel).first();
        if (await loc.count() > 0) {
          const isoAttr = await loc.getAttribute('datetime');
          const txt = (await loc.textContent()) || '';
          const iso = toISO(isoAttr || txt);
          if (iso) { publishedAt = iso; break; }
        }
      }
      await p2.close();
    } catch {
      // 無視して続行
    }

    // 日付が取れないものはスキップ（24h判定ができないため）
    if (!publishedAt) continue;

    // 出典名
    const source = siteName;

    items.push({
      id: 'news-0',
      category,
      title: clip(r.title, 140),
      summary: '',
      source,
      url: r.href,
      publishedAt,
      tags: [],
      locale: 'ja',
      verified: true,
      thumbnail: '',
      type,
      tickers: []
    });
  }

  console.log(`${siteName}: 抽出 ${items.length} 件`);
  return items;
}

function toAbs(base: string, href: string): string {
  try {
    if (/^https?:\/\//i.test(href)) return href;
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function clip(s: string, len: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > len ? t.slice(0, len - 1) + '…' : t;
}

function toISO(raw?: string | null): string | null {
  const s = (raw || '').trim();
  if (!s) return null;

  // すでにISO程度で解釈可能ならそのまま
  const d1 = new Date(s);
  if (!Number.isNaN(+d1)) return d1.toISOString();

  // よくある日付形式（yyyy/mm/dd hh:mm など）
  const m = s.match(/(\d{4})[\/\.\-年](\d{1,2})[\/\.\-月](\d{1,2})[日\sT]*(\d{1,2})?:?(\d{2})?/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    const hh = m[4] ? parseInt(m[4], 10) : 0;
    const mm = m[5] ? parseInt(m[5], 10) : 0;
    const dt = new Date(y, mo, d, hh, mm);
    if (!Number.isNaN(+dt)) return dt.toISOString();
  }

  return null;
}

function guessCategory(source: string, title: string, href: string): 'market' | 'company' {
  const t = (title + ' ' + href).toLowerCase();
  if (/決算|業績|上方修正|下方修正|人事|m&a|買収|合併|子会社|提携|出資|上場/.test(t)) return 'company';
  return 'market';
}

function guessType(title: string, href: string): string | undefined {
  const t = (title + ' ' + href).toLowerCase();
  if (/cpi|pmi|gdp|景気|マクロ|統計|政策|fomc|日銀|利下げ|利上げ/.test(t)) return 'macro';
  if (/決算|業績|通期|四半期|開示|ir|短信|有報/.test(t)) return 'disclosure';
  if (/為替|ドル円|usd\/jpy|fx/.test(t)) return 'fx';
  if (/指数|日経平均|sp500|topix|先物|オプション/.test(t)) return 'equityIndex';
  return undefined;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});