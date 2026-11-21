/* =====================================================================
   Swap well: the family's version of Supermarket Swap.
   Ratings are worked out on the phone from ingredients.json, so updating
   the research instantly updates every product. Products are shared by the
   family in Firestore (households/johnston/swap_catalogue), stored in a few
   large documents so loading the whole catalogue costs only a few reads.
   ===================================================================== */
import * as F from '/family.js';
import { createScorer, splitIngredients } from './scorer.js';

const $ = s => document.querySelector(s);
const esc = F.esc;
const store = { get(k,d){ try{ const v = localStorage.getItem('sw-'+k); return v===null ? d : JSON.parse(v); }catch(e){ return d; } }, set(k,v){ try{ localStorage.setItem('sw-'+k, JSON.stringify(v)); }catch(e){} } };

/* ---------- State ---------- */
let user = null, ING = [], ING_BY_ID = {}, scorer = null;
let PRODUCTS = new Map();            // barcode → product
let HEARTS = new Set();
let view = 'home', storeFilter = store.get('store', 'All');
const scoreCache = new Map();

const RETAILERS = ['Coles','Woolworths','ALDI'];
const CATS = [
  ['breakfast-cereals','Breakfast cereals','🥣'],['biscuits','Biscuits','🍪'],['crisps','Chips and crisps','🥔'],['crackers','Crackers','🍘'],
  ['cereal-bars','Muesli and snack bars','🍫'],['chocolates','Chocolate','🍫'],['candies','Lollies','🍬'],['yogurts','Yoghurt','🥛'],
  ['cheeses','Cheese','🧀'],['breads','Bread','🍞'],['spreads','Spreads','🥜'],['sauces','Sauces','🍅'],['condiments','Condiments and dressings','🫙'],
  ['soups','Soups and stock','🍲'],['pastas','Pasta','🍝'],['instant-noodles','Instant noodles','🍜'],['plant-based-milks','Plant milks','🌱'],
  ['juices-and-nectars','Juice','🧃'],['sodas','Soft drinks','🥤'],['ice-creams','Ice cream','🍦'],['frozen-foods','Frozen meals','🧊'],
  ['sausages','Sausages','🌭'],['hams','Ham and deli meats','🥓'],['baby-foods','Baby and toddler food','👶']
];
const CAT_NAME = Object.fromEntries(CATS.map(c=>[c[0], c[1]]));
const CAT_ICON = Object.fromEntries(CATS.map(c=>[c[0], c[2]]));
const RLABEL = {red:'Avoid or limit', yellow:'OK sometimes', green:'Great choice'};

/* ---------- Ratings (always worked out fresh from the research) ---------- */
function rate(p){
  if(scoreCache.has(p.barcode)) return scoreCache.get(p.barcode);
  const r = p.text && scorer ? scorer.score(p.text, 'food') : {overall_rating:null, parsed_ingredients:[], red_count:0, yellow_count:0};
  scoreCache.set(p.barcode, r); return r;
}
const dot = r => `<span class="dot ${r||'none'}" aria-hidden="true"></span>`;
const badge = r => r ? `<span class="badge ${r}">${r==='red'?'🔴':r==='yellow'?'🟡':'🟢'} ${RLABEL[r]}</span>` : `<span class="badge none">⚪ Not rated yet</span>`;

/* ---------- Catalogue ---------- */
function mergeChunks(rows){
  const m = new Map();
  rows.forEach(ch => Object.entries(ch.items || {}).forEach(([bc, it]) => {
    const prev = m.get(bc);
    const retailers = new Set([...(prev ? prev.retailers : []), ...(it.r || [])]);
    // Family scans and label photos win over catalogue data (they're newer and checked).
    const keep = prev && (prev.src==='label_photo' || prev.src==='manual') && !(it.src==='label_photo' || it.src==='manual') ? prev : null;
    const base = keep || {barcode:bc, name:it.n||'Unnamed product', brand:it.b||'', cat:it.c||ch.cat||'other', text:it.t||'', img:it.i||'', src:it.s||'openfoodfacts', updated:it.u||''};
    if(!keep && prev && !base.text && prev.text){ base.text = prev.text; }
    m.set(bc, {...base, retailers:[...retailers]});
  }));
  PRODUCTS = m; scoreCache.clear(); render();
}
function inStore(p){ return storeFilter==='All' || p.retailers.includes(storeFilter); }
function productItem(p, compact){
  return {barcode:p.barcode, n:p.name, b:p.brand, c:p.cat, t:p.text, i:p.img||'', r:p.retailers||[], s:p.src, u:p.updated||F.isoDate(new Date())};
}
async function saveProduct(p, chunk='scanned'){
  await F.patch('swap_catalogue', chunk, {cat:'mixed', items:{[p.barcode]: productItem(p)}});
}

/* ---------- Open Food Facts (free, no key) ---------- */
const FIELDS = 'code,product_name,product_name_en,brands,ingredients_text,ingredients_text_en,image_front_small_url,stores_tags,stores,categories_tags';
const OFF_SOURCES = [
  ['openfoodfacts','https://au.openfoodfacts.org/api/v2/product/'],
  ['openbeautyfacts','https://world.openbeautyfacts.org/api/v2/product/'],
  ['openproductsfacts','https://world.openproductsfacts.org/api/v2/product/']
];
function retailersOf(x){ const t = ((x.stores||'') + ' ' + (x.stores_tags||[]).join(' ')).toLowerCase(); const r = [];
  if(t.includes('coles')) r.push('Coles'); if(t.includes('woolworths') || t.includes('woolies')) r.push('Woolworths'); if(t.includes('aldi')) r.push('ALDI'); return r; }
function catOf(tags){ const ours = CATS.map(c=>c[0]); const hit = (tags||[]).map(t=>t.replace(/^en:/,'')).filter(t=>ours.includes(t)); return hit[hit.length-1] || 'other'; }
function fromOFF(x, src){ return {barcode:String(x.code), name:x.product_name_en||x.product_name||'Unnamed product', brand:(x.brands||'').split(',')[0].trim(), cat:catOf(x.categories_tags),
  text:(x.ingredients_text_en||x.ingredients_text||'').trim(), img:x.image_front_small_url||'', retailers:retailersOf(x), src, updated:F.isoDate(new Date())}; }
async function fetchJSON(url, ms=9000){ const c = new AbortController(); const t = setTimeout(()=>c.abort(), ms); try{ const r = await fetch(url, {signal:c.signal}); return r.ok ? await r.json() : null; }catch(e){ return null; } finally{ clearTimeout(t); } }
async function lookup(barcode){
  barcode = String(barcode).replace(/\D/g,'');
  if(barcode.length < 8) return {status:'bad'};
  const have = PRODUCTS.get(barcode); if(have) return {status: have.text ? 'found' : 'needs', product:have};
  const answers = await Promise.all(OFF_SOURCES.map(([src, base]) => fetchJSON(base + barcode + '.json?fields=' + FIELDS).then(j => j && j.status===1 && j.product ? {src, x:j.product} : null)));
  const found = answers.filter(Boolean); if(!found.length) return {status:'missing', barcode};
  const best = found.find(f => (f.x.ingredients_text_en||f.x.ingredients_text)) || found[0];
  const p = fromOFF({...best.x, code:barcode}, best.src);
  try{ await saveProduct(p); }catch(e){}
  return {status: p.text ? 'found' : 'needs', product:p};
}

/* ---------- Toast and sheets ---------- */
let tT = null;
function toast(msg){ let t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(tT); tT = setTimeout(()=>t.hidden = true, 3000); }
let sheetStack = [], lastFocus = null;
function openSheet(html, onReady, label='Details'){
  if(!sheetStack.length) lastFocus = document.activeElement;
  sheetStack.push(html); $('#sheetBody').innerHTML = html; $('#sheet').setAttribute('aria-label', label); $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden'; onReady && onReady($('#sheetBody')); setTimeout(()=>$('#sheetClose').focus(), 30);
}
function closeSheet(){ stopScanner(); sheetStack = []; $('#sheet').hidden = true; document.body.style.overflow = ''; if(lastFocus && lastFocus.focus) lastFocus.focus(); }
$('#sheet').addEventListener('click', e => { if(e.target.id==='sheet' || e.target.closest('#sheetClose')) closeSheet(); });
document.addEventListener('keydown', e => { if(e.key==='Escape' && !$('#sheet').hidden) closeSheet(); });

/* ---------- Navigation ---------- */
const VIEWS = ['home','explore','ingredients','hearted','more'];
function go(v){ if(!VIEWS.includes(v)) v='home'; view = v; if(location.hash !== '#'+v) history.replaceState(null,'','#'+v); render(); window.scrollTo(0,0); }
window.addEventListener('hashchange', () => go(location.hash.slice(1)));

/* ---------- Common bits ---------- */
function storePills(){
  return `<div class="pills" role="group" aria-label="Store">${['All',...RETAILERS].map(s=>`<button type="button" class="pill" data-store="${s}" aria-pressed="${storeFilter===s}"><span class="star" aria-hidden="true">${s==='All'?'✱':'★'}</span><span class="pl">${s==='Woolworths'?'Woolies':s}</span></button>`).join('')}</div>`;
}
function card(p, colour){
  const r = rate(p).overall_rating;
  return `<button type="button" class="pcard ${colour||''}" data-product="${esc(p.barcode)}">
    <span class="row1">${dot(r)}<span class="lvl">${r ? RLABEL[r] : 'Not rated yet'}</span>${HEARTS.has(p.barcode)?'<span class="h" aria-label="Hearted">♥</span>':''}</span>
    <b>${esc(p.name)}</b><span class="br">${esc(p.brand||'')}</span>
    <span class="st">${p.retailers.length ? p.retailers.map(esc).join(' · ') : 'Store not listed'}</span></button>`;
}
function row(p){
  const r = rate(p).overall_rating;
  return `<button type="button" class="prow" data-product="${esc(p.barcode)}">${dot(r)}<span class="pt"><b>${esc(p.name)}</b><span>${esc(p.brand||'')}${p.retailers.length?' · '+p.retailers.map(esc).join(', '):''}</span></span>${HEARTS.has(p.barcode)?'<span class="h" aria-label="Hearted">♥</span>':''}</button>`;
}
const RANK = {green:0, yellow:1, red:2};
// Better-rated products in the same category: green first, then yellow (for a red product).
function swapsFor(p, max=6){
  const mine = RANK[rate(p).overall_rating]; if(mine===undefined || mine===0) return [];
  return [...PRODUCTS.values()].filter(x => x.barcode!==p.barcode && x.cat===p.cat && p.cat!=='other' && RANK[rate(x).overall_rating] < mine)
    .sort((a,b) => (RANK[rate(a).overall_rating]-RANK[rate(b).overall_rating]) || (HEARTS.has(b.barcode)-HEARTS.has(a.barcode)) || ((storeFilter!=='All' && b.retailers.includes(storeFilter)) - (storeFilter!=='All' && a.retailers.includes(storeFilter))) || a.name.localeCompare(b.name)).slice(0, max);
}

/* =====================================================================
   PRICES (beta): from prices.json, updated daily by a GitHub Action
   using the open-source Hotprices data (Coles and Woolworths only).
   ===================================================================== */
let PRICES = null, priceIndex = null, PRICEMAP = {};
const STOP = new Set(['the','and','with','of','a','in','pack','each','x','for','australian','aus','fresh']);
const ptoks = s => String(s||'').toLowerCase().replace(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|pk|pack)\b/g, '$1$2').replace(/[^a-z0-9.]+/g,' ').split(' ').filter(w => w && !STOP.has(w)).map(w => w.length>3 && w.endsWith('s') && !/\d/.test(w) ? w.slice(0,-1) : w);
async function loadPrices(){
  if(PRICES) return PRICES;
  try{ const r = await fetch('prices.json', {cache:'no-cache'}); if(!r.ok) return null; PRICES = await r.json(); }catch(e){ return null; }
  priceIndex = {};
  for(const [store, rows] of Object.entries(PRICES.stores || {})){
    const idx = new Map(); rows.forEach((row, k) => { row._t = ptoks(row.n); new Set(row._t).forEach(t => { if(!idx.has(t)) idx.set(t, []); idx.get(t).push(k); }); });
    priceIndex[store] = idx;
  }
  render(); return PRICES;
}
// Best match in one store: most shared words, the brand must appear, sizes must agree when both have one.
function bestMatches(p, store, max=5){
  if(!PRICES || !priceIndex[store]) return [];
  const want = ptoks(`${p.brand||''} ${p.name}`), brand = ptoks(p.brand)[0], size = want.find(t => /^\d/.test(t) && /[a-z]$/.test(t));
  const counts = new Map();
  want.forEach(t => (priceIndex[store].get(t) || []).forEach(k => counts.set(k, (counts.get(k)||0) + 1)));
  const rows = PRICES.stores[store];
  return [...counts.entries()].filter(([k,c]) => c >= 2).map(([k,c]) => { const r = rows[k];
      if(brand && !r._t.includes(brand)) return null;
      const rs = r._t.find(t => /^\d/.test(t) && /[a-z]$/.test(t));
      let score = c / want.length - 0.03 * Math.max(0, r._t.length - c);   // how much of our name is found, minus a little for extra words
      if(size && rs) score += size===rs ? 0.25 : -0.4;
      return {r, score}; }).filter(Boolean).sort((a,b) => b.score - a.score).slice(0, max);
}
function priceFor(p, store){
  const pin = (PRICEMAP[p.barcode]||{})[store];
  if(pin === 'none') return null;
  if(pin){ const r = (PRICES && PRICES.stores[store] || []).find(x => x.i === pin); if(r) return {r, pinned:true}; }
  const m = bestMatches(p, store, 1)[0];
  return m && m.score >= 0.55 ? m : null;
}
const money = n => '$' + (+n).toFixed(2);
const onSpecial = r => r.was && r.p < r.was * 0.97 || r.u && r.p < r.u * 0.9;
function priceCard(p){
  if(!PRICES) return `<p class="note" style="margin-top:12px">💲 Prices (beta) will show here after the first daily update.</p>`;
  const rows = [['coles','Coles'],['woolies','Woolworths']].map(([k,n]) => [k, n, priceFor(p, k)]);
  if(!rows.some(x => x[2])) return `<p class="note" style="margin-top:12px">💲 No price match at Coles or Woolworths yet. <button type="button" class="link" data-pricepick="${esc(p.barcode)}">Find it</button></p>`;
  const found = rows.filter(x=>x[2]), cheapest = found.length > 1 ? found.reduce((a,b) => a[2].r.p <= b[2].r.p ? a : b)[0] : null;
  return `<h3 class="sec">💲 Prices <span class="note" style="font-weight:600">beta · ${esc(PRICES.updated||'')}</span></h3><div class="list">${rows.map(([k,n,m]) => m ? `<div class="prow" style="cursor:default"><span class="dot ${cheapest===k?'green':'none'}" aria-hidden="true"></span><span class="pt"><b>${n}: ${money(m.r.p)}${onSpecial(m.r) ? ` <span class="badge green" style="font-size:12px;padding:2px 8px">🏷️ special${m.r.was?` (was ${money(m.r.was)})`:''}</span>` : ''}</b><span>${esc(m.r.n)}${m.r.u && Math.abs(m.r.u-m.r.p)>0.01 ? ` · usually ${money(m.r.u)}` : ''}${m.r.lo < m.r.p ? ` · lowest lately ${money(m.r.lo)}` : ''}</span></span>${cheapest===k?'<span class="note" style="font-weight:800;color:var(--green)">cheaper</span>':''}</div>` : `<div class="prow" style="cursor:default"><span class="dot none" aria-hidden="true"></span><span class="pt"><b>${n}: not matched</b></span></div>`).join('')}</div>
    <p class="note">Matched by name. <button type="button" class="link" data-pricepick="${esc(p.barcode)}">Not the right product?</button> Online prices, which can differ in store.</p>`;
}
function pricePickSheet(bc){
  const p = PRODUCTS.get(bc); if(!p) return;
  const opts = store => bestMatches(p, store, 5);
  openSheet(`<h2>Match prices</h2><p class="note">Pick the same product at each store, or search.</p>
    <label class="sr" for="pq">Search prices</label><input id="pq" class="search" value="${esc(((p.brand||'')+' '+p.name).trim())}">
    <div id="pres"></div>`, body => {
    const draw = () => { const q = body.querySelector('#pq').value, fake = {...p, brand:'', name:q};
      body.querySelector('#pres').innerHTML = [['coles','Coles'],['woolies','Woolworths']].map(([k,n]) => `<h3 class="sec">${n}</h3><div class="list">${(q.trim() ? bestMatches(fake, k, 6) : opts(k)).map(m => `<button type="button" class="prow" data-pin="${k}|${esc(m.r.i)}"><span class="dot none"></span><span class="pt"><b>${esc(m.r.n)}</b><span>${money(m.r.p)}</span></span></button>`).join('') || '<p class="note">No matches.</p>'}<button type="button" class="link" data-pin="${k}|none">Not sold at ${n}</button></div>`).join('');
      body.querySelectorAll('[data-pin]').forEach(b => b.onclick = async () => { const [k, id] = b.dataset.pin.split('|'); PRICEMAP[bc] = {...(PRICEMAP[bc]||{}), [k]: id};
        try{ await F.put('swap_meta', {id:'pricemap', map:PRICEMAP}); }catch(e){} toast('Saved ✓'); productSheet(bc); }); };
    body.querySelector('#pq').oninput = draw; draw();
  }, 'Match prices');
}
function specialsHTML(){
  if(!PRICES) return '';
  const fav = [...PRODUCTS.values()].filter(p => HEARTS.has(p.barcode)).map(p => ({p, m:[priceFor(p,'coles'), priceFor(p,'woolies')].filter(Boolean).filter(m => onSpecial(m.r))})).filter(x => x.m.length);
  if(!fav.length) return '';
  return `<h2 class="sec">🏷️ On special this week</h2><div class="list">${fav.slice(0,6).map(({p,m}) => `<button type="button" class="prow" data-product="${esc(p.barcode)}"><span class="dot green" aria-hidden="true"></span><span class="pt"><b>${esc(p.name)}</b><span>${m.map(x => `${PRICES.stores.coles.includes(x.r)?'Coles':'Woolies'} ${money(x.r.p)}${x.r.was?` (was ${money(x.r.was)})`:''}`).join(' · ')}</span></span></button>`).join('')}</div>`;
}

/* =====================================================================
   VIEWS
   ===================================================================== */
function render(){
  VIEWS.forEach(v => $('#v-'+v).hidden = v!==view);
  document.querySelectorAll('nav.tabs [data-go]').forEach(b => b.setAttribute('aria-current', b.dataset.go===view ? 'page' : 'false'));
  ({home:renderHome, explore:renderExplore, ingredients:renderIngredients, hearted:renderHearted, more:renderMore})[view]();
}
function flower(){ return `<svg class="flower" viewBox="0 0 200 200" aria-hidden="true"><path fill="var(--orange)" d="M100 92 C82 40 96 6 118 10 C142 14 132 60 108 94 C150 66 192 70 190 96 C188 120 140 116 110 104 C144 140 140 186 114 188 C88 190 96 140 98 110 C76 150 30 160 22 136 C14 112 60 104 92 100 C50 92 20 60 34 40 C48 20 84 52 100 92 Z"/></svg>`; }
function renderHome(){
  const all = [...PRODUCTS.values()];
  const hour = new Date().getHours(), first = (user && user.displayName || '').split(' ')[0];
  const d = new Date(); const today = `Today, ${d.getDate()} ${F.MONTHS[d.getMonth()]}`;
  const recent = store.get('recent', []).map(bc => PRODUCTS.get(bc)).filter(Boolean).slice(0, 6);
  const swapIdeas = recent.filter(p => ['red','yellow'].includes(rate(p).overall_rating)).map(p => ({p, s:swapsFor(p,1)[0]})).filter(x=>x.s).slice(0,3);
  const hearted = all.filter(p => HEARTS.has(p.barcode) && inStore(p)).slice(0, 4);
  const colours = ['c-orange','c-peri','c-pink','c-lilac'];
  $('#v-home').innerHTML = `
    <header class="top"><span class="avatar" aria-hidden="true">${esc((first||'J')[0])}</span><div class="hello"><h1>Hey${first?', '+esc(first):''}</h1><p>${today}</p></div><button type="button" class="icon" data-act="search" aria-label="Search products">🔍</button></header>
    <section class="hero c-lilac"><div class="hero-t"><h2>Swap<br>smarter</h2><p>Scan a barcode or snap the ingredients to see how it rates.</p>
      <div class="row"><button type="button" class="btn dark" data-act="scan">📷 Scan</button><button type="button" class="btn light" data-act="photo">📸 Label photo</button></div></div>${flower()}</section>
    ${storePills()}
    ${swapIdeas.length ? `<h2 class="sec">Swaps for you</h2><div class="grid2">${swapIdeas.map((x,i)=>`<button type="button" class="pcard ${colours[i%4]}" data-product="${esc(x.s.barcode)}"><span class="row1"><span class="lvl">Instead of ${esc(x.p.name)}</span></span><b>Try ${esc(x.s.name)}</b><span class="br">${esc(x.s.brand)}</span><span class="st">${rate(x.s).overall_rating==='green'?'🟢 Great choice':'🟡 A better choice'}</span></button>`).join('')}</div>` : ''}
    ${specialsHTML()}
    ${recent.length ? `<h2 class="sec">Recently checked</h2><div class="grid2">${recent.map((p,i)=>card(p, colours[i%4])).join('')}</div>` : ''}
    ${hearted.length ? `<h2 class="sec">Family favourites ♥</h2><div class="list">${hearted.map(row).join('')}</div>` : ''}
    ${!all.length ? `<div class="empty"><b>Your catalogue is empty</b><p>Go to <b>More</b> and tap <b>Build catalogue</b> to bring in thousands of Australian supermarket products, or start by scanning something from the pantry.</p><button type="button" class="btn dark" data-go="more">Build catalogue</button></div>`
      : `<div class="stats">${['red','yellow','green'].map(r=>`<button type="button" class="stat" data-rating-link="${r}">${dot(r)}<b>${all.filter(p=>rate(p).overall_rating===r).length}</b><span>${RLABEL[r]}</span></button>`).join('')}</div><p class="note">${all.length.toLocaleString('en-AU')} products in your catalogue.</p>`}`;
}
let exCat = store.get('cat',''), exRating = '', exQ = '';
function renderExplore(){
  const q = exQ.toLowerCase().trim();
  const list = [...PRODUCTS.values()].filter(p => inStore(p) && (!exCat || p.cat===exCat) && (!exRating || rate(p).overall_rating===exRating) && (!q || (p.name+' '+p.brand).toLowerCase().includes(q)))
    .sort((a,b) => { const o = {green:0, yellow:1, red:2, null:3}; return (o[rate(a).overall_rating]-o[rate(b).overall_rating]) || a.name.localeCompare(b.name); });
  const counts = {}; [...PRODUCTS.values()].filter(inStore).forEach(p => counts[p.cat] = (counts[p.cat]||0)+1);
  $('#v-explore').innerHTML = `<h1 class="pg">Explore</h1>${storePills()}
    <label class="sr" for="exq">Search the catalogue</label><input id="exq" class="search" placeholder="Search products or brands" value="${esc(exQ)}">
    <div class="chips" role="group" aria-label="Rating">${[['','All ratings'],['green','🟢 Great'],['yellow','🟡 OK sometimes'],['red','🔴 Avoid']].map(([k,l])=>`<button type="button" class="chip" data-rating="${k}" aria-pressed="${exRating===k}">${l}</button>`).join('')}</div>
    <div class="cats" role="group" aria-label="Category"><button type="button" class="cat" data-cat="" aria-pressed="${!exCat}">✨ Everything</button>${CATS.filter(c=>counts[c[0]]).map(c=>`<button type="button" class="cat" data-cat="${c[0]}" aria-pressed="${exCat===c[0]}">${c[2]} ${esc(c[1])} <span>${counts[c[0]]}</span></button>`).join('')}</div>
    <p class="note" role="status">${list.length.toLocaleString('en-AU')} product${list.length===1?'':'s'}${storeFilter!=='All'?` tagged ${esc(storeFilter)}`:''}</p>
    <div class="list">${list.slice(0, 150).map(row).join('') || '<p class="empty-s">Nothing here yet.</p>'}</div>${list.length>150?'<p class="note">Showing the first 150. Narrow it down with a category or search.</p>':''}`;
  const qi = $('#exq'); qi.oninput = e => { exQ = e.target.value; const pos = qi.selectionStart; renderExplore(); const n = $('#exq'); n.focus(); n.setSelectionRange(pos,pos); };
}
let inQ = '', inR = '';
function renderIngredients(){
  const q = inQ.toLowerCase().trim();
  const list = ING.filter(i => (!inR || i.rating===inR) && (!q || [i.canonical_name, ...i.aliases].some(a => a.replace(/^=/,'').toLowerCase().includes(q))));
  const groups = [...new Set(list.map(i=>i.group))];
  $('#v-ingredients').innerHTML = `<h1 class="pg">Ingredients</h1><p class="sub">${ING.length} researched ingredients, each rated with how it’s made, side effects and the strength of the evidence.</p>
    <label class="sr" for="inq">Search ingredients</label><input id="inq" class="search" placeholder="Name or number, e.g. 621 or carrageenan" value="${esc(inQ)}">
    <div class="chips" role="group" aria-label="Rating">${[['','All'],['red','🔴 Red'],['yellow','🟡 Yellow'],['green','🟢 Green']].map(([k,l])=>`<button type="button" class="chip" data-irating="${k}" aria-pressed="${inR===k}">${l}</button>`).join('')}</div>
    ${groups.map(g => `<h2 class="sec">${esc(g)}</h2><div class="list">${list.filter(i=>i.group===g).map(i => { const codes = i.aliases.filter(a=>/^\d{3,4}[a-z]?$/.test(a)).slice(0,4).join(', ');
      return `<button type="button" class="prow" data-ing="${i.id}">${dot(i.rating)}<span class="pt"><b>${esc(i.canonical_name)}</b><span>${esc(codes)}</span></span></button>`; }).join('')}</div>`).join('') || '<p class="empty-s">No matches.</p>'}`;
  const qi = $('#inq'); qi.oninput = e => { inQ = e.target.value; const pos = qi.selectionStart; renderIngredients(); const n = $('#inq'); n.focus(); n.setSelectionRange(pos,pos); };
}
function renderHearted(){
  const list = [...PRODUCTS.values()].filter(p => HEARTS.has(p.barcode) && inStore(p)).sort((a,b)=>a.name.localeCompare(b.name));
  $('#v-hearted').innerHTML = `<h1 class="pg">Family favourites ♥</h1><p class="sub">Products your family loves. Tap the heart on any product to add it. Shared between you both.</p>${storePills()}
    <div class="list">${list.map(row).join('') || '<p class="empty-s">No favourites yet.</p>'}</div>`;
}
function renderMore(){
  const b = store.get('build', {done:[]}), total = CATS.length;
  $('#v-more').innerHTML = `<h1 class="pg">More</h1>
    <section class="panel c-peri"><h2>Build catalogue</h2><p>Brings in Australian supermarket products from the free Open Food Facts database, category by category, and rates them all. It runs while this page is open (the database asks apps to go slowly), and you can stop and carry on later.</p>
      <div class="prog"><i style="width:${Math.round(b.done.length/total*100)}%"></i></div><p class="note" style="margin:6px 0 10px">${b.done.length} of ${total} categories done · ${PRODUCTS.size.toLocaleString('en-AU')} products</p>
      <div class="row"><button type="button" class="btn dark" id="buildGo">${building ? '⏸ Stop' : b.done.length ? '▶ Carry on' : '▶ Build catalogue'}</button>${b.done.length ? '<button type="button" class="btn light" id="buildRe">Refresh all</button>' : ''}</div>
      <p class="note" id="buildLog" role="status" style="margin-top:10px">${esc(buildMsg)}</p></section>
    <section class="panel c-lilac"><h2>💲 Prices (beta)</h2><p>${PRICES ? `Coles and Woolworths prices, updated <b>${esc(PRICES.updated)}</b> (${(PRICES.stores.coles||[]).length.toLocaleString('en-AU')} + ${(PRICES.stores.woolies||[]).length.toLocaleString('en-AU')} products).` : 'Prices appear here after the first daily update runs.'}</p>
      <p class="note">From the free, open-source Hotprices project (hotprices.org), which collects online prices once a day. Unofficial: it may stop working, doesn’t include ALDI, and in-store prices can differ. Specials are flagged when a price is below its usual or previous price.</p></section>
    <section class="panel"><h2>How ratings work</h2><p>${dot('red')} <b>Red</b>: good reason to avoid or limit. ${dot('yellow')} <b>Yellow</b>: fine sometimes, or the evidence is mixed. ${dot('green')} <b>Green</b>: nothing of concern found.</p>
      <p>A product takes the rating of its most concerning ingredient. Ingredients we haven’t researched don’t count for or against it, so a green product means none of its known ingredients are a concern.</p>
      <p class="note">Product information comes from Open Food Facts, which is built by volunteers. Recipes change, so check the pack if something matters to you. General information, not medical advice.</p></section>
    <section class="panel"><h2>Store tags</h2><p class="note">Open Food Facts doesn’t always say which store sells a product, so the Coles, Woolies and ALDI filters only show products that are tagged. Everything shows under All.</p></section>`;
  $('#buildGo').onclick = () => building ? stopBuild() : startBuild(false);
  const re = $('#buildRe'); if(re) re.onclick = () => { if(confirm('Refresh every category from Open Food Facts?')) startBuild(true); };
}

/* =====================================================================
   PRODUCT AND INGREDIENT SHEETS
   ===================================================================== */
function productSheet(bc){
  const p = PRODUCTS.get(bc); if(!p) return;
  const recent = store.get('recent', []).filter(x=>x!==bc); recent.unshift(bc); store.set('recent', recent.slice(0, 20));
  const sc = rate(p), r = sc.overall_rating, swaps = ['red','yellow'].includes(r) ? swapsFor(p) : [];
  const flagged = sc.parsed_ingredients.filter(x=>x.matched).sort((a,b) => ({red:0,yellow:1,green:2}[a.rating]-{red:0,yellow:1,green:2}[b.rating]));
  const others = sc.parsed_ingredients.filter(x=>!x.matched);
  const online = 'https://www.google.com/search?q=' + encodeURIComponent(`${CAT_NAME[p.cat]||p.name} no additives Australia`);
  openSheet(`<div class="ptop ${r||'none'}">${p.img ? `<img src="${esc(p.img)}" alt="" class="pimg" loading="lazy" referrerpolicy="no-referrer">` : `<span class="pimg ph" aria-hidden="true">${CAT_ICON[p.cat]||'🛒'}</span>`}
      <div><p class="kick">${esc(p.brand||'')}</p><h2 id="pName">${esc(p.name)}</h2>${badge(r)}</div></div>
    <div class="row" style="margin:12px 0"><button type="button" class="btn ${HEARTS.has(bc)?'dark':'light'}" id="heart" aria-pressed="${HEARTS.has(bc)}">${HEARTS.has(bc)?'♥ Favourite':'♡ Add to favourites'}</button><span class="note">${p.retailers.length ? esc(p.retailers.join(' · ')) : 'Store not listed'}</span></div>
    ${priceCard(p)}
    ${!p.text ? `<div class="panel c-pink"><b>No ingredient list yet</b><p>Snap a photo of the ingredients and it’ll be rated straight away.</p><button type="button" class="btn dark" data-act="photo" data-bc="${esc(bc)}">📸 Snap ingredients</button></div>` : ''}
    ${swaps.length ? `<h3 class="sec">🔁 Swap it for</h3><div class="hscroll">${swaps.map((s,i)=>card(s, ['c-orange','c-peri','c-pink','c-lilac'][i%4])).join('')}</div>` : (['red','yellow'].includes(r) ? `<p class="note">No better swaps in this category yet. <a href="${online}" target="_blank" rel="noopener">Search for cleaner options online ↗</a></p>` : '')}
    ${flagged.length ? `<h3 class="sec">What we found</h3><div class="list">${flagged.map(x=>`<button type="button" class="prow" data-ing="${esc(x.ingredient_id)}">${dot(x.rating)}<span class="pt"><b>${esc(x.canonical_name)}</b><span>on the label as “${esc(x.text)}”</span></span><span class="chev" aria-hidden="true">›</span></button>`).join('')}</div>` : (p.text ? '<p class="note">None of its ingredients are on our watch list. 🎉</p>' : '')}
    ${others.length ? `<details class="more"><summary>Other ingredients (${others.length})</summary><p>${others.map(x=>esc(x.text)).join(' · ')}</p></details>` : ''}
    <details class="more"><summary>Full ingredient list and details</summary><p>${esc(p.text || 'No ingredient list.')}</p><p class="note">Barcode ${esc(bc)} · ${p.src==='label_photo' ? 'from a label photo' : 'from Open Food Facts'}${p.updated ? ' · updated '+esc(p.updated) : ''}</p>
      <button type="button" class="btn light" data-act="photo" data-bc="${esc(bc)}">✏️ Fix the ingredients</button></details>
    ${['red','yellow'].includes(r) ? `<a class="btn light wide" href="${online}" target="_blank" rel="noopener" style="margin-top:12px">🔎 Find cleaner options online</a>` : ''}`, body => {
    body.querySelector('#heart').onclick = async () => { const on = !HEARTS.has(bc); on ? HEARTS.add(bc) : HEARTS.delete(bc);
      try{ await F.put('swap_meta', {id:'hearts', list:[...HEARTS]}); }catch(e){ toast('Couldn’t save. Check you’re online.'); } productSheet(bc); render(); };
  }, p.name);
}
function ingredientSheet(id){
  const i = ING_BY_ID[id]; if(!i) return;
  const n = [...PRODUCTS.values()].filter(p => rate(p).parsed_ingredients.some(x=>x.ingredient_id===id)).length;
  const EV = {strong:'Strong evidence', moderate:'Moderate evidence', limited:'Limited evidence'};
  openSheet(`<div class="ptop ${i.rating}"><span class="pimg ph" aria-hidden="true">🔬</span><div><p class="kick">${esc(i.group||'Ingredient')}</p><h2>${esc(i.canonical_name)}</h2>${badge(i.rating)}</div></div>
    <p class="note" style="margin-top:12px">${EV[i.evidence]||''}${n ? ` · in ${n} product${n===1?'':'s'} in your catalogue` : ''}</p>
    <h3 class="sec">How it’s made</h3><p>${esc(i.how_its_made)}</p>
    <h3 class="sec">Side effects and evidence</h3><p>${esc(i.side_effects)}</p>
    <h3 class="sec">Should you avoid it?</h3><p>${esc(i.avoid_guidance)}</p>
    <h3 class="sec">Also listed as</h3><p class="note">${esc(i.aliases.map(a=>a.replace(/^=/,'')).join(', '))}</p>
    <h3 class="sec">Sources</h3><p class="note">${esc((i.sources||[]).join(' · '))}</p>`, null, i.canonical_name);
}

/* =====================================================================
   SCANNER, LABEL PHOTO, SEARCH
   ===================================================================== */
function loadScript(src){ return new Promise((ok, no) => { if(document.querySelector(`script[src="${src}"]`)) return ok(); const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
/* ---------- Live barcode scanner ----------
   Uses the phone's own barcode reader where there is one (Android Chrome), otherwise
   zxing-cpp compiled to WebAssembly (scanner.js + zxing_reader.wasm), which reads
   supermarket barcodes quickly in iPhone Safari. */
const FORMATS = ['ean_13','ean_8','upc_a','upc_e'];
let detector = null, cam = null;
async function getDetector(){
  if(detector) return detector;
  if('BarcodeDetector' in window){ try{ const f = await window.BarcodeDetector.getSupportedFormats(); if(f.includes('ean_13')) return detector = new window.BarcodeDetector({formats:FORMATS}); }catch(e){} }
  const m = await import('./scanner.js'); return detector = new m.BarcodeDetector({formats:FORMATS});
}
function stopScanner(){ if(cam){ cam.stopped = true; clearTimeout(cam.timer); (cam.stream ? cam.stream.getTracks() : []).forEach(t=>t.stop()); cam = null; } }
async function scanSheet(){
  openSheet(`<h2>Scan a barcode</h2><p class="note" id="scanMsg" role="status">Starting the camera…</p>
    <div class="reader"><video id="vid" playsinline muted autoplay></video><div class="aim" aria-hidden="true"><i></i></div><button type="button" class="torch" id="torch" hidden aria-pressed="false">🔦</button></div>
    <p class="note">Hold the barcode inside the box, about 15–20 cm away. It scans automatically.</p>
    <label class="lbl" for="bcIn">Or type the numbers under the barcode</label><div class="row"><input id="bcIn" class="search" inputmode="numeric" placeholder="e.g. 9300633600113" style="flex:1"><button type="button" class="btn dark" id="bcGo">Look up</button></div>`, async body => {
    const msg = t => { const m = body.querySelector('#scanMsg'); if(m) m.textContent = t; };
    body.querySelector('#bcGo').onclick = () => handleBarcode(body.querySelector('#bcIn').value);
    const video = body.querySelector('#vid');
    try{
      const [det, stream] = await Promise.all([getDetector(), navigator.mediaDevices.getUserMedia({audio:false, video:{facingMode:{ideal:'environment'}, width:{ideal:1920}, height:{ideal:1080}}})]);
      if($('#sheet').hidden || !body.isConnected){ stream.getTracks().forEach(t=>t.stop()); return; }
      cam = {stream, stopped:false, timer:null};
      const track = stream.getVideoTracks()[0], caps = track.getCapabilities ? track.getCapabilities() : {};
      try{ if((caps.focusMode||[]).includes('continuous')) await track.applyConstraints({advanced:[{focusMode:'continuous'}]}); }catch(e){}
      if(caps.torch){ const tb = body.querySelector('#torch'); tb.hidden = false; tb.onclick = async () => { const on = tb.getAttribute('aria-pressed')!=='true'; try{ await track.applyConstraints({advanced:[{torch:on}]}); tb.setAttribute('aria-pressed', String(on)); }catch(e){} }; }
      video.srcObject = stream; await video.play().catch(()=>{});
      msg('Point the camera at the barcode.');
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', {willReadFrequently:true});
      let last = '', hits = 0;
      const tick = async () => {
        if(!cam || cam.stopped) return;
        const vw = video.videoWidth, vh = video.videoHeight;
        if(vw && vh){
          // Only read the middle band, where the box is: faster and more accurate.
          const cw = Math.floor(vw*0.9), ch = Math.floor(vh*0.5);
          canvas.width = cw; canvas.height = ch; ctx.drawImage(video, (vw-cw)/2, (vh-ch)/2, cw, ch, 0, 0, cw, ch);
          try{
            const found = await det.detect(canvas);
            const code = found && found[0] && String(found[0].rawValue||'').replace(/\D/g,'');
            if(code && code.length >= 8){
              hits = code===last ? hits+1 : 1; last = code;
              if(hits >= 2 || det.constructor.name==='BarcodeDetector'){ if(navigator.vibrate) navigator.vibrate(60); stopScanner(); handleBarcode(code); return; }
            }
          }catch(e){}
        }
        if(cam && !cam.stopped) cam.timer = setTimeout(tick, 90);
      };
      tick();
    }catch(e){
      const why = String(e && (e.name || e.message || e)).toLowerCase();
      msg(why.includes('notallowed') || why.includes('permission') ? 'Camera permission is off. In iPhone Settings → Safari → Camera, choose Allow or Ask, then tap Scan again.'
        : why.includes('notfound') || why.includes('overconstrained') ? 'No camera found. Type the numbers under the barcode instead.'
        : 'The camera didn’t start. Close this and tap Scan again, or type the numbers.');
      const r = body.querySelector('.reader'); if(r) r.style.display = 'none';
    }
  }, 'Scan a barcode');
}
async function handleBarcode(code){
  const msg = $('#scanMsg'); if(msg) msg.textContent = 'Found '+String(code).replace(/\D/g,'')+'. Looking it up…';
  const res = await lookup(code);
  if(res.status==='bad'){ if(msg) msg.textContent = 'That doesn’t look like a barcode.'; return; }
  if(res.status==='missing'){ closeSheet(); photoSheet(String(code).replace(/\D/g,''), true); return; }
  PRODUCTS.set(res.product.barcode, {...res.product}); scoreCache.delete(res.product.barcode);
  closeSheet(); productSheet(res.product.barcode); render();
}
function photoSheet(bc, isNew){
  const p = bc ? PRODUCTS.get(bc) : null;
  openSheet(`<h2>${isNew ? 'New product' : p ? 'Fix the ingredients' : 'Label photo'}</h2>
    ${isNew ? '<p class="note">This one isn’t in any database yet. Snap the ingredients and add it: it’ll be saved for the whole family.</p>' : '<p class="note">Take a clear, close photo of just the ingredients list.</p>'}
    <label class="btn dark wide" style="margin:10px 0">📸 Take or choose a photo<input type="file" accept="image/*" capture="environment" id="ph" class="sr"></label>
    <p class="note" id="ocrMsg" role="status"></p>
    <label class="lbl" for="pIng">Ingredients (check and fix any mistakes)</label><textarea id="pIng" class="search" rows="6" placeholder="Ingredients: …">${esc(p ? p.text : '')}</textarea>
    <label class="lbl" for="pName2">Product name</label><input id="pName2" class="search" value="${esc(p ? p.name : '')}">
    <div class="grid2"><div><label class="lbl" for="pBrand">Brand</label><input id="pBrand" class="search" value="${esc(p ? p.brand : '')}"></div>
      <div><label class="lbl" for="pCat">Category</label><select id="pCat" class="search">${[['other','Other'],...CATS.map(c=>[c[0],c[1]])].map(([k,l])=>`<option value="${k}" ${p&&p.cat===k?'selected':''}>${esc(l)}</option>`).join('')}</select></div></div>
    <label class="lbl" for="pBc">Barcode (optional)</label><input id="pBc" class="search" inputmode="numeric" value="${esc(bc||'')}">
    <p class="lbl">Where do you buy it?</p><div class="chips">${RETAILERS.map(s=>`<label class="chip"><input type="checkbox" value="${s}" ${p&&p.retailers.includes(s)?'checked':''}> ${s==='Woolworths'?'Woolies':s}</label>`).join('')}</div>
    <div id="preview" style="margin-top:12px"></div>
    <button type="button" class="btn dark wide" id="pSave" style="margin-top:14px">Save and rate it</button>`, body => {
    const live = () => { const t = body.querySelector('#pIng').value; const r = t.trim() && scorer ? scorer.score(t,'food').overall_rating : null; body.querySelector('#preview').innerHTML = t.trim() ? badge(r) : ''; };
    body.querySelector('#pIng').oninput = live; live();
    body.querySelector('#ph').onchange = async e => { const f = e.target.files[0]; if(!f) return; const m = body.querySelector('#ocrMsg');
      m.textContent = 'Reading the label… (the first time takes a little longer)';
      try{ await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
        const res = await window.Tesseract.recognize(f, 'eng'); const txt = res.data.text.replace(/\s*\n\s*/g,' ').trim();
        body.querySelector('#pIng').value = txt; live(); m.textContent = 'Done! Check the text for mistakes before saving.';
      }catch(err){ m.textContent = 'Couldn’t read the photo. Try a closer, brighter photo, or type the ingredients.'; } };
    body.querySelector('#pSave').onclick = async () => {
      const text = body.querySelector('#pIng').value.trim(), name = body.querySelector('#pName2').value.trim();
      if(!text || !name){ toast('Add the product name and ingredients first.'); return; }
      const code = body.querySelector('#pBc').value.replace(/\D/g,'') || ('x'+Date.now().toString(36));
      const prod = {barcode:code, name, brand:body.querySelector('#pBrand').value.trim(), cat:body.querySelector('#pCat').value, text, img:p?p.img:'', src:'label_photo', updated:F.isoDate(new Date()),
        retailers:[...body.querySelectorAll('.chips input:checked')].map(i=>i.value)};
      try{ await saveProduct(prod); }catch(e){ toast('Couldn’t save. Check you’re signed in and online.'); return; }
      PRODUCTS.set(code, prod); scoreCache.delete(code); closeSheet(); productSheet(code); render(); toast('Saved for the family ✓');
    };
  }, 'Label photo');
}
function searchSheet(){
  openSheet(`<h2>Search</h2><label class="sr" for="sq">Search products</label><input id="sq" class="search" placeholder="Product, brand or barcode" autocomplete="off"><div class="list" id="sres" style="margin-top:10px"></div>`, body => {
    const inp = body.querySelector('#sq'); inp.focus();
    inp.oninput = () => { const q = inp.value.toLowerCase().trim(); const words = q.split(/\s+/).filter(Boolean);
      const res = q ? [...PRODUCTS.values()].filter(p => p.barcode===q.replace(/\D/g,'') || words.every(w => (p.name+' '+p.brand).toLowerCase().includes(w))).slice(0, 40) : [];
      body.querySelector('#sres').innerHTML = res.map(row).join('') || (q ? `<p class="note">Not in your catalogue yet.${/^\d{8,14}$/.test(q) ? ' <button type="button" class="btn light" id="sLook">Look up this barcode</button>' : ''}</p>` : '');
      const lk = body.querySelector('#sLook'); if(lk) lk.onclick = () => { closeSheet(); scanSheet(); setTimeout(()=>{ const b = $('#bcIn'); if(b){ b.value = q; handleBarcode(q); } }, 200); }; };
  }, 'Search');
}

/* =====================================================================
   CATALOGUE BUILDER (Open Food Facts search, politely paced)
   ===================================================================== */
let building = false, buildMsg = '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function stopBuild(){ building = false; buildMsg = 'Stopped. Tap Carry on to continue.'; render(); }
async function startBuild(refresh){
  if(refresh) store.set('build', {done:[]});
  building = true; render();
  const st = store.get('build', {done:[]});
  for(const [cat, name] of CATS){
    if(!building) break;
    if(st.done.includes(cat)) continue;
    const items = {}; let count = 0;
    for(let page=1; page<=3 && building; page++){
      buildMsg = `Fetching ${name}, page ${page}…`; const log = $('#buildLog'); if(log) log.textContent = buildMsg;
      const url = `https://au.openfoodfacts.org/api/v2/search?countries_tags_en=australia&categories_tags_en=${cat}&fields=${FIELDS}&page_size=100&page=${page}&sort_by=unique_scans_n`;
      const j = await fetchJSON(url, 20000);
      const prods = (j && j.products) || [];
      prods.forEach(x => { if(!x.code || !(x.product_name||x.product_name_en)) return; const p = fromOFF(x, 'openfoodfacts'); p.cat = cat; items[p.barcode] = productItem(p); count++; });
      if(prods.length < 100) break;
      await sleep(6500); // Open Food Facts asks apps to keep searches to about 10 a minute
    }
    if(!building) break;
    if(count){ try{ await F.put('swap_catalogue', {id:'off-'+cat, cat, items, at:Date.now()}); }catch(e){ buildMsg = 'Couldn’t save to the family database. Check you’re signed in.'; building = false; render(); return; } }
    st.done.push(cat); store.set('build', st);
    buildMsg = `${name}: added ${count} products.`; render();
    await sleep(6500);
  }
  if(building){ building = false; buildMsg = 'All done! 🎉'; render(); }
}

/* =====================================================================
   CLICKS AND START-UP
   ===================================================================== */
document.addEventListener('click', e => {
  const t = e.target.closest('button,a,label'); if(!t) return;
  const d = t.dataset;
  if(d.go){ e.preventDefault(); if(!$('#sheet').hidden) closeSheet(); go(d.go); return; }
  if(d.store){ storeFilter = d.store; store.set('store', storeFilter); render(); return; }
  if(d.product){ productSheet(d.product); return; }
  if(d.ing){ ingredientSheet(d.ing); return; }
  if(d.rating !== undefined && t.classList.contains('chip')){ exRating = d.rating; renderExplore(); return; }
  if(d.irating !== undefined){ inR = d.irating; renderIngredients(); return; }
  if(d.cat !== undefined && t.classList.contains('cat')){ exCat = d.cat; store.set('cat', exCat); renderExplore(); return; }
  if(d.ratingLink){ exRating = d.ratingLink; exCat = ''; go('explore'); return; }
  if(d.act==='scan'){ scanSheet(); return; }
  if(d.act==='photo'){ const bc = d.bc || null; if(!$('#sheet').hidden) closeSheet(); photoSheet(bc, false); return; }
  if(d.act==='search'){ searchSheet(); return; }
  if(d.pricepick){ pricePickSheet(d.pricepick); return; }
});

async function start(){
  try{ const j = await fetch('ingredients.json').then(r => r.json()); ING = j.ingredients; ING.forEach(i => ING_BY_ID[i.id] = i); scorer = createScorer(ING); }
  catch(e){ toast('Couldn’t load the ingredient research.'); }
  $('#signin').onclick = () => F.signIn().catch(() => $('#gatemsg').textContent = 'Sign-in didn’t work. Please try again.');
  F.watchUser(u => {
    user = u;
    if(!u){ $('#gate').hidden = false; $('#tabs').hidden = true; VIEWS.forEach(v => $('#v-'+v).hidden = true); return; }
    $('#gate').hidden = true; $('#tabs').hidden = false;
    F.listen('swap_catalogue', mergeChunks, () => toast('Couldn’t load the catalogue. Check you’re signed in.'));
    F.listen('swap_meta', rows => { const h = rows.find(r=>r.id==='hearts'); HEARTS = new Set(h ? h.list : []); const pm = rows.find(r=>r.id==='pricemap'); PRICEMAP = pm ? (pm.map||{}) : {}; render(); }, () => {});
    loadPrices();
    go(location.hash.slice(1) || 'home');
  });
}
start();
