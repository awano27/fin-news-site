const state = {
  all: [],
  view: [],
  filter: 'all',
  query: '',
  sort: 'date_desc',
  type: 'all',         // 追加: 種別フィルタ
  issuer: 'all',       // 追加: 発行体（企業固有か）フィルタ
  dedupe: true         // 追加: 重複抑止
};

const el = {
  cards: document.getElementById('cards'),
  empty: document.getElementById('empty'),
  search: document.getElementById('search'),
  sort: document.getElementById('sort'),
  nav: document.querySelector('.nav'),
};

init();

async function init(){
  attachEvents();
  await loadData();
  render();
}

/**
 * データ読み込み（ローカルJSON）
 * レポートの基準に合わせ、verified=true のみ掲載
 */
async function loadData(){
  try{
    const res = await fetch('assets/data/news.json', { cache: 'no-store' });
    if(!res.ok) throw new Error('Failed to load data');
    const items = await res.json();

    // 正常化とバリデーション（最低限）
    state.all = items
      .filter(x => x && x.url && x.verified !== false) // undefinedはtrue扱い、falseは除外
      .map(x => normalizeItem(x));

  }catch(err){
    console.error('データ読み込みエラー:', err);
    state.all = [];
  }
}

/**
 * アイテムの正規化 + MECE補助フィールド推定
 */
function normalizeItem(x){
  const cat = ['market','company','sns'].includes(x.category) ? x.category : 'market';
  const title = (x.title || '(タイトル不明)').toString();
  const summary = (x.summary || '').toString();
  const source = (x.source || '').toString();
  const url = x.url;
  const publishedAt = parseDate(x.publishedAt);
  const tags = Array.isArray(x.tags) ? x.tags.slice(0,8) : [];
  const locale = x.locale || 'ja';
  const verified = x.verified !== false;
  const thumbnail = x.thumbnail || '';

  // 新フィールド（任意）
  let type = (x.type || '').toString();         // 'earnings' | 'disclosure' | 'macro' | 'fx' | 'equityIndex' | 'policy' | ...
  const tickers = Array.isArray(x.tickers) ? x.tickers : []; // ['5401.T'] など

  // typeが未指定の場合、タイトル・タグから推定（簡易ルール）
  if(!type){
    const t = (title + ' ' + summary + ' ' + tags.join(' ')).toLowerCase();
    if(/決算|業績|通期|四半期|eps|売上|ガイダンス/.test(t)) type = 'earnings';
    else if(/開示|適時開示|有報|短信|ir/.test(t)) type = 'disclosure';
    else if(/為替|ドル円|usd\/jpy|fx/.test(t)) type = 'fx';
    else if(/cpi|pmi|gdp|景気|マクロ|失業|物価|政策|日銀|fomc/.test(t)) type = 'macro';
    else if(/日経平均|topix|sp500|指数|先物|オプション/.test(t)) type = 'equityIndex';
    else type = cat === 'company' ? 'companyNews' : 'marketNews';
  }

  // issuer（発行体の有無）: company＝企業固有、market＝非企業、sns＝対象外
  const issuer = cat === 'company' ? 'withIssuer' : 'noIssuer';

  return {
    id: x.id || cryptoRandomId(),
    category: cat,
    title,
    summary,
    source,
    url,
    publishedAt,
    tags,
    locale,
    verified,
    thumbnail,
    type,
    tickers,
    issuer
  };
}

function parseDate(v){
  const d = new Date(v);
  return isNaN(+d) ? null : d;
}

function cryptoRandomId(){
  try{
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return [...a].map(n => n.toString(16).padStart(2,'0')).join('');
  }catch{
    return Math.random().toString(36).slice(2,10);
  }
}

function attachEvents(){
  // ナビゲーションのフィルタ
  el.nav.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-filter]');
    if(!a) return;
    e.preventDefault();
    document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
    a.classList.add('active');
    state.filter = a.dataset.filter;
    render();
  });

  // 検索
  el.search.addEventListener('input', (e) => {
    state.query = e.target.value.trim();
    render();
  });

  // 並び替え
  el.sort.addEventListener('change', (e) => {
    state.sort = e.target.value;
    render();
  });
}

function applyFilter(items){
  let out = items;

  // カテゴリフィルタ
  if(state.filter !== 'all'){
    out = out.filter(x => x.category === state.filter);
  }

  // 種別フィルタ（type）
  if(state.type !== 'all'){
    out = out.filter(x => (x.type || '') === state.type);
  }

  // 発行体フィルタ（issuer）
  if(state.issuer !== 'all'){
    out = out.filter(x => (x.issuer || 'noIssuer') === state.issuer);
  }

  // 検索（タイトル・要約・ソース・タグ）
  if(state.query){
    const q = state.query.toLowerCase();
    out = out.filter(x => {
      return (
        x.title.toLowerCase().includes(q) ||
        x.summary.toLowerCase().includes(q) ||
        x.source.toLowerCase().includes(q) ||
        (x.tags||[]).some(t => (t||'').toLowerCase().includes(q)) ||
        (x.tickers||[]).some(t => (t||'').toLowerCase().includes(q))
      );
    });
  }

  // 重複抑止（URLベース + タイトル近似）
  if(state.dedupe){
    out = dedupeItems(out);
  }

  // 並び替え
  out = out.slice();
  switch(state.sort){
    case 'date_asc':
      out.sort((a,b) => (a.publishedAt?.getTime()||0) - (b.publishedAt?.getTime()||0));
      break;
    case 'title_asc':
      out.sort((a,b) => a.title.localeCompare(b.title, 'ja'));
      break;
    case 'title_desc':
      out.sort((a,b) => b.title.localeCompare(a.title, 'ja'));
      break;
    case 'date_desc':
    default:
      out.sort((a,b) => (b.publishedAt?.getTime()||0) - (a.publishedAt?.getTime()||0));
      break;
  }

  return out;
}

function dedupeItems(arr){
  const seenUrl = new Set();
  const keep = [];
  for(const it of arr){
    const u = (it.url || '').trim();
    const keyUrl = u.replace(/[#?].*$/, ''); // クエリ/ハッシュを除去して比較
    const titleKey = (it.title || '').trim().toLowerCase().replace(/\s+/g,' ');
    const urlHit = keyUrl && seenUrl.has(keyUrl);
    const titleHit = keep.some(k => {
      const t = (k.title||'').trim().toLowerCase().replace(/\s+/g,' ');
      return t && titleKey && t === titleKey;
    });
    if(urlHit || titleHit) continue;
    if(keyUrl) seenUrl.add(keyUrl);
    keep.push(it);
  }
  return keep;
}

function render(){
  state.view = applyFilter(state.all);
  el.cards.innerHTML = '';
  if(state.view.length === 0){
    el.empty.hidden = false;
    return;
  }
  el.empty.hidden = true;

  const frag = document.createDocumentFragment();
  state.view.forEach(item => {
    frag.appendChild(renderCard(item));
  });
  el.cards.appendChild(frag);
}

function renderCard(item){
  const a11yCat = item.category === 'market' ? '市場ニュース'
                : item.category === 'company' ? '企業ニュース'
                : 'SNS投稿';

  const card = document.createElement('article');
  card.className = 'card';
  card.setAttribute('aria-label', `${a11yCat}: ${item.title}`);

  const body = document.createElement('div');
  body.className = 'card-body';

  // バッジ
  const badges = document.createElement('div');
  badges.className = 'badges';
  const catBadge = document.createElement('span');
  catBadge.className = 'badge';
  catBadge.textContent = a11yCat;
  badges.appendChild(catBadge);

  if(item.type){
    const t = document.createElement('span');
    t.className = 'badge';
    t.textContent = item.type;
    badges.appendChild(t);
  }

  if(item.issuer){
    const iss = document.createElement('span');
    iss.className = 'badge';
    iss.textContent = item.issuer === 'withIssuer' ? '企業固有' : '市場/マクロ';
    badges.appendChild(iss);
  }

  if(item.verified){
    const v = document.createElement('span');
    v.className = 'badge';
    v.textContent = '検証済み';
    badges.appendChild(v);
  }

  (item.tags || []).slice(0,3).forEach(t => {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = t;
    badges.appendChild(b);
  });

  // タイトル
  const h = document.createElement('h3');
  h.className = 'card-title';
  h.textContent = item.title;

  // 要約
  if(item.summary){
    const p = document.createElement('p');
    p.className = 'card-summary';
    p.textContent = item.summary;
    body.appendChild(p);
  }

  // メタ
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  if(item.source){
    const s = document.createElement('span');
    s.textContent = item.source;
    meta.appendChild(s);
  }
  if(item.publishedAt){
    const d = document.createElement('time');
    d.dateTime = item.publishedAt.toISOString();
    d.textContent = formatDate(item.publishedAt);
    meta.appendChild(d);
  }

  // tickersを軽く表示
  if(Array.isArray(item.tickers) && item.tickers.length){
    const tk = document.createElement('div');
    tk.className = 'card-meta';
    tk.textContent = `Ticker: ${item.tickers.slice(0,3).join(', ')}`;
    body.appendChild(tk);
  }

  body.prepend(badges);
  body.appendChild(h);
  body.appendChild(meta);

  // アクション
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const link = document.createElement('a');
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'button';
  link.innerHTML = '記事を開く';
  actions.appendChild(link);

  const ext = document.createElement('span');
  ext.className = 'extmark';
  ext.textContent = '外部サイト';
  actions.appendChild(ext);

  card.appendChild(body);
  card.appendChild(actions);

  return card;
}

function formatDate(d){
  try{
    return new Intl.DateTimeFormat('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(d);
  }catch{
    return d.toISOString();
  }
}