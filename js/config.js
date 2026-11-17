/*
 * 設定ファイル（幹事さんが編集するのは基本的にここだけ）
 *
 * SECTIONS の1要素が、Googleフォーム1つに対応する（クイズ = "quiz"、以心伝心ゲーム予想 = "pred"）。
 * 問題数は form.answerEntries の個数で決まる。
 * ゲストが答えられるのは、司会画面がいま受付を開けている問題だけ（js/gate.js）。
 * 編集方法は README.md を参照。
 *
 * 【重要・フォーム側の前提】回答は「1問ごと」に送信する。
 * 1回の送信に入るのは「名前＋その1問」だけなので、クイズ用フォームの
 * 第1問〜第10問は「必須」をオフにしておくこと（名前は必須のままでよい）。
 * 必須のままだと、他の問題が空の送信を Google が受け付けず、回答が記録されない。
 */

export const SECTIONS = [
  {
    id: "quiz", // 送信済み状態の保存キーと、受付の対象（"q1"〜"q10"）に使う。変えない
    title: "クイズ（全10問）",
    // 問題文はスライドに出すので、ページ側は共通の案内だけを表示する
    promptLines: ["スクリーンの問題を見て", "選んでください"],
    // フォームに送る値そのもの。フォーム側の選択肢と1文字でも違うと記録されない（A/B/C/D は半角）
    // 【注意】フォーム側の第1問〜第10問に選択肢「D」が無いと、D の回答は Google に黙って捨てられる
    //（ゲストの画面は「送信済み」になる）。フォームに D を足してから公開すること。README.md 参照。
    choices: ["A", "B", "C", "D"],
    // 選択肢のボタンを横に何個並べるか（省略すると縦1列）。4択は 2×2 にして、スマホで1画面に収める
    choiceColumns: 2,
    progressLabel: (index, total) => `第${index + 1}問 / ${total}`,
    answerLabel: (index) => `第${index + 1}問`, // 「第3問は送信済みです」の表示に使う
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
    id: "pred", // 受付の対象（"pred"）に使う。変えない
    title: "以心伝心ゲーム予想",
    // 予想はスライドではなく、この質問文をゲストの画面に出す
    promptLines: ["新郎新婦の答えは", "5問中 何問そろいますか？"],
    choices: ["0問", "1問", "2問", "3問", "4問", "5問"],
    choiceColumns: 2, // 2×3 に並べて、質問文・選択肢・送信ボタンをスマホの1画面に収める
    progressLabel: () => "以心伝心ゲーム",
    answerLabel: () => "予想",
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

/*
 * 受付状態（いまどの問題を受け付けているか）を、回答ページが読みに行く間隔など。
 * 読む先は HOST.statsUrl（…/exec?action=state）。
 */
export const GATE = {
  // 何ミリ秒ごとに読むか。全員が同時に読まないよう、毎回 0〜jitterMs をランダムに足す。
  // 前の応答が返ってからこの時間を待つので、実際の間隔は「応答にかかる時間（1〜2秒）＋ 1〜1.5秒」
  pollMs: 1000,
  jitterMs: 500,
  // この時間（ミリ秒）応答がなければ、その回は失敗として扱う
  timeoutMs: 8000,
  // 失敗が続くほど間隔をあける。その上限（ミリ秒）
  maxBackoffMs: 20000,
  // 最後に読めてからこの時間（ミリ秒）を過ぎたら、状態が分からないものとして回答ボタンを出さない
  //（つながらない間に締め切られた問題へ、気づかずに答えてしまわないように）
  staleMs: 20000,
};

/*
 * Apps Script ウェブアプリの設定。司会画面（host.html）と、回答ページの受付状態の取得で使う。
 */
export const HOST = {
  // 集計用 Apps Script ウェブアプリの URL（https://script.google.com/macros/s/…/exec）。
  // 空のままだと司会画面は「未設定」の案内を表示し、回答ページは問題を出せない。
  // 設定手順は README.md の「司会画面」を参照。
  statsUrl: "https://script.google.com/macros/s/AKfycbzBHCykKSa5ZCUgvMJnNfgk9oq0z_R99E7ZRp8ki_jjGs2-094TuIGJO5Covbeiz8I5/exec",
  // 司会画面が、何ミリ秒ごとに人数と受付状態を取りに行くか。応答（2〜3秒かかる）を待たずに次を始める
  pollMs: 500,
  // 同時に進める取得の上限。応答が遅い・返らないときも、これ以上は重ねない
  maxInFlight: 2,
  // 取得の失敗が続くほど間隔をあける。その上限（ミリ秒）
  maxBackoffMs: 8000,
  // この時間（ミリ秒）応答がなければ、その回は失敗として扱う（前回の表示は残す）
  timeoutMs: 8000,
  // "fetch" : 通常はこちら。
  // "jsonp" : fetch で取得できない環境向けの予備（<script> タグで読み込む）。
  transport: "fetch",
  // スライド一覧（statsUrl に ?action=slides&key=… を付けて取得）を待つ時間（ミリ秒）。
  // 初回は Google 側でスライド画像を作るので時間がかかる。司会キーやスライドの ID はここに書かない
  slidesTimeoutMs: 60000,
};
