/*
 * 設定ファイル（幹事さんが編集するのは基本的にここだけ）
 *
 * SECTIONS の1要素が、メニューの1ボタン＝Googleフォーム1つに対応する。
 * 問題数は form.answerEntries の個数で決まる（1個なら1問だけの画面になる）。
 * 編集方法は README.md を参照。
 *
 * 【重要・フォーム側の前提】回答は「1問ごと」に送信する。
 * 1回の送信に入るのは「名前＋その1問」だけなので、クイズ用フォームの
 * 第1問〜第10問は「必須」をオフにしておくこと（名前は必須のままでよい）。
 * 必須のままだと、他の問題が空の送信を Google が受け付けず、回答が記録されない。
 */

export const SECTIONS = [
  {
    id: "quiz", // 送信済み状態の保存キーにも使う。途中で変えない
    menuLabel: "クイズ（全10問）",
    // 問題文はスライドに出すので、ページ側は共通の案内だけを表示する
    promptLines: ["スクリーンの問題を見て", "選んでください"],
    // フォームに送る値そのもの。フォーム側の選択肢と1文字でも違うと記録されない（A/B/C は半角）
    choices: ["A", "B", "C"],
    progressLabel: (index, total) => `第${index + 1}問 / ${total}`,
    answerLabel: (index) => `第${index + 1}問`, // 「第3問は送信済みです」の表示に使う
    // 全問を送り終えたときに完了画面へ出す文
    doneMessage: "クイズの回答を受け付けました。結果発表をお楽しみに！",
    // ページがうまく動かない人向けの、フォームへの直接リンク
    fallback: { label: "クイズのフォーム", url: "https://forms.gle/XmHLsmcajpB2wd218" },
    /* クイズ用フォーム（名前＋第1問〜第10問、11ページ）。第1問〜第10問は「必須」オフが前提 */
    form: {
      action: "https://docs.google.com/forms/d/e/1FAIpQLSdAFFk24pUGKVtx4RHVpMdSXgKofk_-XKUq784UOIC9LTO0qw/formResponse",
      nameEntry: "entry.1147305893",
      answerEntries: [
        "entry.255388641",  // 第1問
        "entry.1791143091", // 第2問
        "entry.795446734",  // 第3問
        "entry.118695384",  // 第4問
        "entry.1636061687", // 第5問
        "entry.883132054",  // 第6問
        "entry.612739454",  // 第7問
        "entry.1174654339", // 第8問
        "entry.633267418",  // 第9問
        "entry.1363924360", // 第10問
      ],
      // 複数ページ（セクション区切りあり）のフォームは、通過したページ番号を
      // pageHistory で全部申告しないと、1ページ目の項目しか記録されない。
      // 「0 から (ページ数 - 1) まで」をカンマ区切りで並べる。11ページなので 0〜10。
      // 1問ずつ送る場合も、どのページの問題でも記録されるよう毎回この全ページ分を送る。
      pageHistory: "0,1,2,3,4,5,6,7,8,9,10",
    },
  },
  {
    id: "pred",
    menuLabel: "以心伝心ゲーム予想",
    promptLines: ["新郎新婦の答えは", "5問中 何問そろいますか？"],
    choices: ["0問", "1問", "2問", "3問", "4問", "5問"],
    progressLabel: () => "以心伝心ゲーム",
    answerLabel: () => "予想",
    doneMessage: "予想を受け付けました。結果発表をお楽しみに！",
    fallback: { label: "予想のフォーム", url: "https://forms.gle/P3A1VpHLHZuu6wNn8" },
    /* 予想用フォーム（名前＋予想、1ページ） */
    form: {
      action: "https://docs.google.com/forms/d/e/1FAIpQLScLpoVfv_zUhA5plt0ZJd3qyD9OMbwLQUvja0Wi_afbKZeExg/formResponse",
      nameEntry: "entry.1335687347",
      answerEntries: ["entry.504448424"],
      pageHistory: "0", // 1ページだけのフォーム
    },
  },
];

export const SUBMIT = {
  // "fetch"  : 通常はこちら。圏外などの通信失敗を検知して、エラーと再送信ボタンを出せる。
  // "iframe" : 以前の方式（隠しiframeへのフォームPOST）。失敗を検知できず、常に「受け付けました」になる。
  //            fetch 方式で回答がスプレッドシートに入らない場合の退避用。
  transport: "fetch",
  // この時間（ミリ秒）応答がなければ失敗として扱い、もう一度送信してもらう
  timeoutMs: 15000,
};
