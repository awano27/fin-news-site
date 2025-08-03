const state = {
  all: [],
  view: [],
  filter: 'all',
  query: '',
  sort: 'date_desc',
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
 * アイテムの正規化
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
    thumbnail
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

  // 検索（タイトル・要約・ソース・タグ）
  if(state.query){
    const q = state.query.toLowerCase();
    out = out.filter(x => {
      return (
        x.title.toLowerCase().includes(q) ||
        x.summary.toLowerCase().includes(q) ||
        x.source.toLowerCase().includes(q) ||
        (x.tags||[]).some(t => (t||'').toLowerCase().includes(q))
      );
    });
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