'use client';

import { useEffect, useRef } from 'react';

/**
 * 既存のバニラJS画面を Next.js の上で動かすための土台。
 *
 * ★ 移行メモ（この小さなコンポーネントが、UIを1ピクセルも変えずに移行できた理由です）
 *
 *   この教材の画面（先生用・生徒用）は、サーバから届いた状態を見て
 *   DOM を直接組み立てる作りになっています（client/teacher.js・client/play.js）。
 *   ここを React コンポーネントへ書き直すと、
 *     - 数百行の描画ロジックを全部書き換えることになる
 *     - 授業で使える完成度の画面に、見た目の崩れが混入する
 *   という割に合わないリスクを負います。
 *
 *   一方で移行の目的は「インフラをサーバレスに載せ替えること」であって、
 *   描画方式を変えることではありません。そこで React には
 *     1. 元のマークアップを1回だけ置く
 *     2. body に元と同じクラスを付ける（CSS が body.screen-* を見ているため）
 *     3. 既存のコントローラを起動する
 *   の3つだけを担当させています。
 *
 *   包む <div> には display:contents を指定します。
 *   app.css の body { display:flex; flex-direction:column } がそのまま効くように、
 *   この <div> をレイアウト上「無いもの」として扱わせるためです。
 */
export default function VanillaPage({
  markup,
  bodyClass,
  boot,
}: {
  markup: string;
  bodyClass: string;
  /** 既存コントローラを読み込む関数（動的 import を渡す） */
  boot: () => Promise<unknown>;
}) {
  const booted = useRef(false);

  useEffect(() => {
    // 開発時の二重実行や、戻る操作での再マウントで
    // コントローラが2つ動かないようにする
    if (booted.current) return;
    booted.current = true;

    // body のクラスは**最初の1回だけ**当てる。
    // 起動後は ui.js の showScreen() が screen-* クラスを付け替えて画面を切り替えるので、
    // ここで再代入すると、進行中の画面を参加画面のCSSに戻してしまう。
    document.body.className = bodyClass;

    // マークアップが DOM に入ったあとで起動する。
    // 既存コントローラは読み込まれた瞬間に $('#codeInput') などを探すため、順番が重要。
    void boot().catch((err) => {
      console.error('[boot] 画面の起動に失敗しました', err);
    });
    // 意図的に初回のみ。bodyClass / boot はページごとに固定です。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: markup }} />;
}
