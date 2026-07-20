// Overpass APIへの実際のリクエスト頻度と、どこからエラー(429/504等)になるかを検証する
// 使い捨てスクリプト。Node 18以降(グローバルfetch)が必要。
// 使い方: node test-overpass-freq.js
//   node test-overpass-freq.js burst 10       … 間隔なしで10連続
//   node test-overpass-freq.js concurrent 3    … 3並列同時発射
//   node test-overpass-freq.js paced 1000 10   … 1000ms間隔で10回

const QUERY = '[out:json][timeout:5];node[amenity=cafe](35.68,139.76,35.69,139.77);out 1;';
const URL = 'https://overpass-api.de/api/interpreter';

async function oneRequest(n) {
  const t0 = Date.now();
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '*/*',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Origin': 'https://overpass-turbo.eu',
        'Referer': 'https://overpass-turbo.eu/',
      },
      body: 'data=' + encodeURIComponent(QUERY),
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    const retryAfter = res.headers.get('retry-after');
    console.log(`#${n}\tstatus=${res.status}\telapsed=${elapsed}s${retryAfter ? '\tretry-after=' + retryAfter : ''}`);
    return res.status;
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`#${n}\tERROR\telapsed=${elapsed}s\t${e.message}${e.cause ? '\tcause=' + e.cause : ''}`);
    return null;
  }
}

async function burst(n) {
  console.log(`=== burst: ${n}回を間隔なしで順番に発射 ===`);
  for (let i = 1; i <= n; i++) await oneRequest(i);
}

async function concurrent(n) {
  console.log(`=== concurrent: ${n}本を完全同時に発射 ===`);
  await Promise.all(Array.from({ length: n }, (_, i) => oneRequest(i + 1)));
}

async function paced(intervalMs, n) {
  console.log(`=== paced: ${intervalMs}ms間隔で${n}回 ===`);
  for (let i = 1; i <= n; i++) {
    await oneRequest(i);
    if (i < n) await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function main() {
  const [, , mode, a, b] = process.argv;
  if (mode === 'burst') return burst(parseInt(a || '10', 10));
  if (mode === 'concurrent') return concurrent(parseInt(a || '3', 10));
  if (mode === 'paced') return paced(parseInt(a || '1000', 10), parseInt(b || '10', 10));
  if (mode === 'sanity') {
    // Overpass固有の問題かネットワーク全般の問題かを切り分けるための対照実験
    console.log('=== 対照実験: example.comへの疎通確認 ===');
    try {
      const r = await fetch('https://example.com');
      console.log('example.com status=', r.status);
    } catch (e) {
      console.log('example.com ERROR', e.message, e.cause || '');
    }
    return;
  }
  // 既定: まず単発で疎通確認
  console.log('=== 単発疎通確認 ===');
  await oneRequest(1);
}

main();
