/*
 * 司会画面（host.html）が Apps Script ウェブアプリ（apps-script/Code.gs）から読むもの。
 *
 *   集計        …/exec                          誰でも読める（人数だけ）
 *   スライド一覧 …/exec?action=slides&key=司会キー  司会キーが合うときだけ返る
 *
 * 司会キーは URL（host.html?key=…）で一度だけ受け取り、この端末の localStorage に保存する。
 * リポジトリや config.js には書かない（スライドには正解のページがあるため）。
 */

const KEY_STORAGE = "wg-host-key";

/**
 * 司会キーを取り出す。URL に ?key=… があればそれを保存し、アドレスバーからは消す
 * （画面を映したときにキーが見えないように）。?key= と空で渡すと、保存したキーを消す。
 */
export function takeHostKey() {
  const url = new URL(location.href);
  if (url.searchParams.has("key")) {
    const key = url.searchParams.get("key").trim();
    try {
      if (key) localStorage.setItem(KEY_STORAGE, key);
      else localStorage.removeItem(KEY_STORAGE);
    } catch (e) {
      /* 保存できない環境（プライベートブラウズなど）では、このページを開いている間だけ使う */
    }
    url.searchParams.delete("key");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    return key;
  }
  try {
    return localStorage.getItem(KEY_STORAGE) || "";
  } catch (e) {
    return "";
  }
}

/*
 * fetch 方式（通常）。
 * 「全員」に公開した Apps Script ウェブアプリは、/exec → script.googleusercontent.com への
 * リダイレクト後の応答に Access-Control-Allow-Origin: * が付くので、別オリジンからそのまま読める。
 * 独自ヘッダーを付けない単純な GET なのでプリフライトも起きない。
 * credentials:"omit" で Google のログイン Cookie を送らないのが大事な点で、司会の PC が複数の
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

function loadJson(url, params, { timeoutMs, transport }) {
  const load = transport === "jsonp" ? loadViaJsonp : loadViaFetch;
  return load(withParams(url, { ...params, t: Date.now() }), timeoutMs);
}

/** 集計 JSON を取得する。想定の形でなければ（HTML のエラーページなど）例外にする。 */
export async function fetchStats(url, options) {
  const stats = await loadJson(url, {}, options);
  if (!stats || typeof stats !== "object" || typeof stats.quiz !== "object" || typeof stats.pred !== "object") {
    throw new Error("unexpected response");
  }
  return stats;
}

/**
 * スライド一覧を取得する。
 * refresh: "all"（全部作り直す）または objectId のカンマ区切り（その画像だけ作り直す）。
 * Code.gs が { error } を返したときは、error.code にその種類を入れた例外にする
 * （"unauthorized" = キー違い、"not_configured" = Google 側が未設定、"deck_error" = スライドを開けない）。
 * Code.gs が古くて action=slides を知らない場合は集計 JSON が返るので、code: "unsupported" にする。
 */
export async function fetchSlideList(url, key, refresh, options) {
  const params = { action: "slides", key };
  if (refresh) params.refresh = refresh;
  const data = await loadJson(url, params, options);
  if (data && typeof data.error === "string") {
    throw Object.assign(new Error(data.message || data.error), { code: data.error });
  }
  if (!data || !Array.isArray(data.slides)) {
    throw Object.assign(new Error("Apps Script がスライド一覧に対応していません（Code.gs の更新と再デプロイが必要）"), { code: "unsupported" });
  }
  return data;
}
