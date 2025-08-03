import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { assertFileExistsOrThrow } from './utils';

type Candidate = {
  id: string;
  category: 'sns';
  title: string;
  summary: string;
  source: string; // e.g. "X: @nikkei"
  url: string;
  publishedAt: string | null; // ISO8601
  tags: string[];
  locale: 'ja';
  verified: boolean;
  thumbnail: string;
};

const STORAGE_PATH = process.env.PW_STORAGE_STATE_PATH || 'scripts/x/storageState.json';
const NEWS_JSON = 'assets/data/news.json';
// 既定ターゲット（15件程度に調整）: 為替/日本株系の主要アカウント
const DEFAULT_TARGETS = [
  '@nikkei',
  '@ReutersJapan',
  '@Gaitame_com',
  '@QUICK_QMW',
  '@NHK_news',
  '@BloombergJapan',
  '@WSJJapan',
  '@JPX_official',
  '@TSE_pr',
  '@MonexJP',
  '@RakutenSec',
  '@SBISEC',
  '@kabutan_jp',
  '@minkabu_jp',
  '@YOL_economy'
];
const TARGET_HANDLES = (process.env.X_TARGETS || DEFAULT_TARGETS.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const PER_ACCOUNT_LIMIT = parseInt(process.env.PER_ACCOUNT_LIMIT || '5', 10);
// クリーンモード: ダミー（example.com）や特定ID（sns-10..14）を取り込み前に削除
const CLEAN_MODE = (process.env.CLEAN_MODE || 'true').toLowerCase() !== 'false';

// 企業優先モード（trueで issuer=withIssuer を優先し、決算/開示系のtypeのみ追加）
const COMPANY_PRIORITY = (process.env.COMPANY_PRIORITY || 'false').toLowerCase() === 'true';

async function main() {
  assertFileExistsOrThrow(STORAGE_PATH, `storageState がありません。先に npm run pw:login を実行してログイン状態を保存してください: ${STORAGE_PATH}`);
  assertFileExistsOrThrow(NEWS_JSON, `news.json が見つかりません: ${NEWS_JSON}`);

  // 既存の news.json を読み込み
  let existing = JSON.parse(fs.readFileSync(NEWS_JSON, 'utf-8')) as any[];

  // クリーンモードでダミーエントリを削除
  if (CLEAN_MODE) {
    const before = existing.length;
    existing = existing.filter((x) => {
      if (!x) return false;
      // URLがexample.com配下は削除
      const isExample = typeof x.url === 'string' && /(^|\/\/)example\.com/i.test(x.url);
      // 事前に作成したダミーIDの範囲を削除（sns-10..sns-14）
      const isDummyId = typeof x.id === 'string' && /^sns-(1[0-4])$/.test(x.id);
      return !(isExample || isDummyId);
    });
    const removed = before - existing.length;
    if (removed > 0) {
      fs.writeFileSync(NEWS_JSON, JSON.stringify(existing, null, 2), 'utf-8');
      console.log(`クリーン: ダミー項目を ${removed} 件削除しました。`);
    } else {
      console.log('クリーン: 削除対象のダミー項目はありませんでした。');
    }
  }

  const browser = await chromium.launch({ headless: false });
  const context: BrowserContext = await browser.newContext({ storageState: STORAGE_PATH });
  const page = await context.newPage();

  const added: Candidate[] = [];
  for (const handle of TARGET_HANDLES) {
    const list = await fetchFromAccount(page, handle, PER_ACCOUNT_LIMIT);
    added.push(...list);
  }

  if (added.length === 0) {
    console.log('追加候補が見つかりませんでした。条件を見直してください。');
    await browser.close();
    return;
  }

  // 既存のURL集合と次の採番を準備
  const existingAfterClean = JSON.parse(fs.readFileSync(NEWS_JSON, 'utf-8')) as any[];
  const existingUrls = new Set(existingAfterClean.map(x => (x && x.url) || ''));
  const nextIdStart = calcNextIdStart(existingAfterClean);

  let idCounter = nextIdStart;
  const toAppend: any[] = [];
  for (const c of added) {
    if (!c.url || existingUrls.has(c.url)) continue;
    toAppend.push({
      ...c,
      id: `sns-${idCounter++}`
    });
  }

  if (toAppend.length === 0) {
    console.log('新規に追加できるURLはありません（既存と重複）。');
    await browser.close();
    return;
  }

  const merged = existingAfterClean.concat(toAppend);
  fs.writeFileSync(NEWS_JSON, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`news.json に ${toAppend.length} 件を追記しました。`);

  await browser.close();
}

function calcNextIdStart(items: any[]): number {
  // 既存の id: "sns-N" の最大値+1を返す
  let max = 0;
  for (const it of items) {
    const m = typeof it?.id === 'string' ? it.id.match(/^sns-(\d+)$/) : null;
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) max = Math.max(max, n);
    }
  }
  return max + 1;
}

async function fetchFromAccount(page: Page, handle: string, limit: number): Promise<Candidate[]> {
  const url = `https://x.com/${handle.replace(/^@/, '')}`;
  console.log(`アクセス: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // ある程度スクロールして直近ポストを読み込む
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('End');
    await page.waitForTimeout(1000);
  }

  // ツイート/ポスト要素（XのUI変更により壊れやすいためセレクタは汎用的に）
  // role="article" のカードを候補にし、内部テキストやリンクからURL/本文を抽出
  const articles = await page.locator('article').elementHandles();

  const candidates: Candidate[] = [];
  for (const a of articles) {
    if (candidates.length >= limit) break;

    // 本文テキスト
    const text = (await a.evaluate((el) => el.textContent || '')).trim();
    if (!text) continue;

    // ポストパーマリンク（/user/status/123...）を含むリンクを探す
    const links = await a.$$('a[href*="/status/"]');
    if (links.length === 0) continue;

    // 最初のリンクをポストURLとみなす
    const href = await links[0].evaluate((el: any) => (el.getAttribute('href') as string) || '');
    if (!href) continue;

    const absoluteUrl = toAbsoluteUrl('https://x.com', href);
    
    // 金融関連キーワードのフィルタリング（関連性の高い投稿のみ収集）
    const isFinanceRelated = /決算|業績|株価|為替|日経|ドル円|日銀|政策|金利|投資|経済|GDP|CPI|上場|下落|上昇|急落|急伸|銀行|企業|市場|マーケット|トレーディング|アナリスト|予想|サプライズ|速報|緊急|警告|注意/.test(text.toLowerCase());
    // アカウントが既に金融系の場合はフィルタを緩める
    const isFinanceAccount = /@(nikkei|reuters|bloomberg|gaitame|quick|nhk_news|monex|rakuten|sbi|kabutan|minkabu|yol_economy)/i.test(handle);
    if (!isFinanceRelated && !isFinanceAccount) continue;
    
    const title = clipTitle(text, 100);
    const summary = clipSummary(text, 200);

    const publishedAt = await extractPublishedTime(a).catch(() => null);

    candidates.push({
      id: 'sns-0', // 後で採番
      category: 'sns',
      title,
      summary,
      source: `X: ${handle}`,
      url: absoluteUrl,
      publishedAt,
      tags: [],
      locale: 'ja',
      verified: true,
      thumbnail: ''
    });
  }

  // 重複URLを同アカウント内で排除
  const uniq = uniqBy(candidates, (c) => c.url);
  console.log(`${handle}: 抽出 ${uniq.length} 件`);
  return uniq.slice(0, limit);
}

function toAbsoluteUrl(base: string, href: string): string {
  try {
    if (/^https?:\/\//i.test(href)) return href;
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function clipTitle(s: string, len: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > len ? t.slice(0, len - 1) + '…' : t;
}

function clipSummary(s: string, len: number): string {
  // タイトルと同じでも可。必要なら別整形に変更。
  return clipTitle(s, len);
}

async function extractPublishedTime(handle: import('playwright').ElementHandle): Promise<string | null> {
  // timeタグまたはdatetime属性を探索
  try {
    const timeEl = await handle.$('time');
    if (!timeEl) return null;
    const dt = await timeEl.getAttribute('datetime');
    if (!dt) return null;
    // Xの datetime はISO8601想定
    return dt;
  } catch {
    return null;
  }
}

function uniqBy<T>(arr: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr) {
    const k = key(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});