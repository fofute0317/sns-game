/**
 * テスト用ビルド。
 *
 * なぜ必要か:
 *   node --test は TypeScript をそのまま実行できず、Next.js のパス別名（@/lib/...）も知りません。
 *   そこで tsconfig.test.json で lib/ と client/ を CommonJS へ出力し、
 *   出力ファイルに残った別名だけを相対パスへ書き換えます。
 *
 *   本番のビルド（next build）はこの処理を一切使いません。
 *   あくまで「テストから同じソースを読むため」のものです。
 *
 * 使い方:  node scripts/build-tests.mjs   （npm test から自動で呼ばれます）
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.test-build');

console.log('[test-build] TypeScript をコンパイルしています…');
// npx/tsc の実行ファイルは OS で名前が変わるため、パッケージ本体を node で直接呼ぶ
execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.test.json'], {
  cwd: ROOT,
  stdio: 'inherit',
});

/** .test-build 以下の .js を全部たどる */
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

// require("@/lib/engine") → require("../lib/engine")
// （.test-build/client/x.js から見た相対位置）
let patched = 0;
for (const file of walk(OUT)) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(path.dirname(file), path.join(OUT, 'lib')).split(path.sep).join('/') || '.';
  const next = src.replace(/(["'])@\/lib\//g, (_m, q) => `${q}${rel}/`);
  if (next !== src) {
    fs.writeFileSync(file, next, 'utf8');
    patched++;
  }
}
// リポジトリのルートは "type": "module" なので、
// CommonJS で出力したこのフォルダだけ、明示的に commonjs に戻しておく。
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2), 'utf8');

console.log(`[test-build] 完了（別名を書き換えたファイル: ${patched}件）`);
