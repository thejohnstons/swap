"""Daily price update for Swap well (runs on GitHub Actions, free).

Downloads the latest Coles and Woolworths files published by the open-source
Hotprices project (hotprices.org), keeps what the app needs, and writes
prices.json next to the app. If anything looks wrong, the previous prices.json
is left untouched, so the app keeps showing the last good prices.
"""
import gzip, json, sys, urllib.request, datetime

SOURCES = {
    'coles': 'https://hotprices.org/data/latest-canonical.coles.compressed.json.gz',
    'woolies': 'https://hotprices.org/data/latest-canonical.woolies.compressed.json.gz',
}
UA = {'User-Agent': 'johnston-family-swap-well (personal use; daily)'}

def download(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
    try:
        raw = gzip.decompress(raw)
    except OSError:
        pass  # already decompressed by the server
    return json.loads(raw)

def decompress(blob):
    """Heisse Preise 'compressed' layout: {stores, n, dates, data:[...]}, where each item is
    store, id, name, category, unavailable, historyLength, (dateIndex, price)*, unit,
    quantity, isWeighted, bio, url. Also accepts a plain list of canonical items."""
    if isinstance(blob, list):
        return blob
    dates, data, stores = blob['dates'], blob['data'], blob.get('stores', [])
    items, i = [], 0
    for _ in range(blob['n']):
        store = data[i]; i += 1
        pid = data[i]; i += 1
        name = data[i]; i += 1
        category = data[i]; i += 1
        unavailable = data[i]; i += 1
        n_hist = data[i]; i += 1
        if not isinstance(n_hist, int) or n_hist < 0 or n_hist > 5000:
            raise ValueError('unexpected layout')
        hist = []
        for _ in range(n_hist):
            d = str(dates[data[i]]); p = data[i + 1]; i += 2
            hist.append({'date': f'{d[0:4]}-{d[4:6]}-{d[6:8]}' if len(d) == 8 else d, 'price': p})
        unit = data[i]; i += 1
        qty = data[i]; i += 1
        i += 1  # isWeighted
        i += 1  # bio
        url = data[i]; i += 1
        items.append({'store': stores[store] if isinstance(store, int) and store < len(stores) else store,
                      'id': pid, 'name': name, 'unavailable': bool(unavailable), 'priceHistory': hist,
                      'price': hist[0]['price'] if hist else None, 'unit': unit, 'quantity': qty, 'url': url})
    return items

def slim(item):
    hist = sorted(item.get('priceHistory') or [], key=lambda h: h['date'], reverse=True)
    if not hist or item.get('unavailable') or not item.get('name'):
        return None
    now = hist[0]['price']
    prev = next((h['price'] for h in hist[1:] if h['price'] != now), None)
    cutoff = (datetime.date.today() - datetime.timedelta(days=120)).isoformat()
    recent = [h['price'] for h in hist if h['date'] >= cutoff] or [now]
    usual = sorted(recent)[len(recent) // 2]          # the median recent price
    row = {'i': str(item.get('id')), 'n': item['name'], 'p': now, 'lo': min(recent), 'u': usual}
    if prev is not None and prev > now: row['was'] = prev
    if item.get('quantity') and item.get('unit'): row['q'] = f"{item['quantity']}{item['unit']}"
    return row

def main():
    out = {'updated': datetime.date.today().isoformat(), 'source': 'hotprices.org', 'stores': {}}
    for store, url in SOURCES.items():
        items = decompress(download(url))
        rows = [r for r in (slim(x) for x in items) if r and isinstance(r['p'], (int, float)) and 0 < r['p'] < 2000]
        if len(rows) < 1000:
            sys.exit(f'{store}: only {len(rows)} products, leaving prices.json as it was')
        out['stores'][store] = rows
        print(store, len(rows), 'products')
    with open('prices.json', 'w') as f:
        json.dump(out, f, separators=(',', ':'), ensure_ascii=False)

if __name__ == '__main__':
    main()
