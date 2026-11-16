/*
 * Googleフォームへの送信。画面（DOM の表示）には関与しない。
 * 成功なら resolve、失敗なら reject する Promise を返すだけ。
 */

/**
 * フォームに送る [項目名, 値] の一覧を組み立てる。
 * 1回の送信に入れるのは「名前＋1問ぶんの回答」だけ（他の問題の項目は送らない）。
 */
export function buildFields(form, name, questionIndex, answer) {
  return [
    [form.nameEntry, name],
    [form.answerEntries[questionIndex], answer],
    ["pageHistory", form.pageHistory],
    ["fvv", "1"],
  ];
}

/**
 * 1問ぶんの回答を送信する。
 * @param {object} form          config.js の form 定義
 * @param {string} name          回答者の名前
 * @param {number} questionIndex 何問目か（0始まり。form.answerEntries の添字）
 * @param {string} answer        回答（フォームの選択肢と同じ文字列）
 * @param {{transport?: string, timeoutMs?: number}} options
 */
export function submitAnswer(form, name, questionIndex, answer, { transport = "fetch", timeoutMs = 15000 } = {}) {
  const fields = buildFields(form, name, questionIndex, answer);
  return transport === "iframe"
    ? postViaIframe(form.action, fields)
    : postViaFetch(form.action, fields, timeoutMs);
}

/*
 * fetch 方式。
 * Googleフォームは CORS を許可していないので mode:"no-cors" で送る。応答は中身の読めない
 * opaque response になり、HTTPステータスは分からない（項目IDの誤りなどは検知できない）。
 * それでも「サーバーに届かなかった」場合（圏外・DNS失敗・タイムアウト）は reject されるので、
 * 会場の電波が悪いときに誤って「受け付けました」と出すことは防げる。
 * URLSearchParams を body にすると application/x-www-form-urlencoded になり、
 * 通常のフォーム送信と同じ形式（プリフライトなし）で届く。
 */
async function postViaFetch(action, fields, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(action, {
      method: "POST",
      mode: "no-cors",
      body: new URLSearchParams(fields),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/*
 * iframe 方式（以前の実装）。隠し iframe に向けて <form> を POST する。
 * 別オリジンの iframe は中身も成否も見えないため、load イベントか4秒経過で「成功」とみなす。
 * つまり圏外でも成功扱いになる。config.js の SUBMIT.transport で明示的に選んだときだけ使う。
 */
function postViaIframe(action, fields) {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.name = "gform-target-" + Date.now();
    iframe.hidden = true;

    const formEl = document.createElement("form");
    formEl.method = "POST";
    formEl.action = action;
    formEl.target = iframe.name;
    formEl.hidden = true;
    for (const [key, value] of fields) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value;
      formEl.appendChild(input);
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      formEl.remove();
      // 応答の読み込み途中で iframe を消さないよう、少し待ってから片付ける
      setTimeout(() => iframe.remove(), 1000);
      resolve();
    };

    document.body.append(iframe, formEl);
    // 空の iframe を追加した時点の load を拾わないよう、submit の直前に登録する
    iframe.addEventListener("load", finish);
    const timer = setTimeout(finish, 4000);
    formEl.submit();
  });
}
