/*
 * Apps Script ウェブアプリ（apps-script/Code.gs）から JSON を読む。回答ページと司会画面の両方で使う。
 */

/*
 * fetch 方式（通常）。
 * 「全員」に公開した Apps Script ウェブアプリは、/exec → script.googleusercontent.com への
 * リダイレクト後の応答に Access-Control-Allow-Origin: * が付くので、別オリジンからそのまま読める。
 * 独自ヘッダーを付けない単純な GET なのでプリフライトも起きない。
 * credentials:"omit" で Google のログイン Cookie を送らないのが大事な点で、端末が複数の
 * Google アカウントでログインしていても、常に「匿名のアクセス」として同じ結果が返る
 * （Cookie が付く JSONP だと、この場合にログイン画面へ飛ばされて失敗することがある）。
 */
async function loadViaFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials: "omit", redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* JSONP 方式（予備）。HOST.transport を "jsonp" にしたときだけ使う。 */
let jsonpSeq = 0;
function loadViaJsonp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const name = "__wgJsonp" + ++jsonpSeq;
    const script = document.createElement("script");
    const finish = (fn, arg) => {
      clearTimeout(timer);
      script.remove();
      window[name] = () => {}; // 遅れて届いた応答でエラーにならないよう、空の関数を残す
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error("timeout")), timeoutMs);
    window[name] = (data) => finish(resolve, data);
    script.onerror = () => finish(reject, new Error("script load failed"));
    script.src = withParams(url, { callback: name });
    document.head.appendChild(script);
  });
}

function withParams(url, params) {
  const u = new URL(url);
  Object.entries(params).forEach(([key, value]) => u.searchParams.set(key, String(value)));
  return u.toString();
}

/** url に params を付けて読む。毎回ちがう t を付けて、ブラウザや途中のキャッシュを避ける。 */
export function loadJson(url, params, { timeoutMs, transport }) {
  const load = transport === "jsonp" ? loadViaJsonp : loadViaFetch;
  return load(withParams(url, { ...params, t: Date.now() }), timeoutMs);
}
