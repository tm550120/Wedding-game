/*
 * 司会画面（host.html）。会場のスクリーンに映し、いま表示中の問題について
 * 「どの選択肢を何人が選んだか」を数秒ごとに更新して見せる。
 *
 * データは Apps Script ウェブアプリ（apps-script/Code.gs）が返す集計 JSON を読むだけで、
 * Google フォームへは何も送らない。名前はこのページには届かない（人数だけ）。
 *
 *   { updatedAt, quiz: { "1": {A,B,C,total}, …, "10": {…} }, pred: { "0問": n, …, "5問": n, total } }
 *
 * 操作: 下のボタン、または ← / →（前後）、1〜9・0（第1〜9問・第10問）、P（予想）、F（全画面）。
 * host.html?demo=1 で開くと、Apps Script なしでダミーの数字を表示する。
 *
 * 【将来の正解発表について】いまは人数の表示だけ。足すときは、Code.gs が「正解」タブを読んで
 * JSON に正解を含め、renderStats() で該当する行に .correct、それ以外に .dimmed を付ければよい
 * （スタイルは css/host.css に用意済み）。
 */
import { SECTIONS, HOST } from "./config.js";

const $ = (id) => document.getElementById(id);

const DEMO = new URLSearchParams(location.search).get("demo") === "1";

/*
 * 表示の単位（ビュー）。クイズは1問ごと、予想は1つ。config.js の SECTIONS から作るので、
 * 問題数や選択肢を変えてもここは直さなくてよい。pick は集計 JSON からそのビューの人数を取り出す。
 */
const VIEWS = SECTIONS.flatMap((section) => {
  const count = section.form.answerEntries.length;
  if (count === 1) {
    return [{
      title: section.menuLabel,
      kicker: section.promptLines.join(""),
      navLabel: section.answerLabel(0),
      choices: section.choices,
      pick: (stats) => stats?.[section.id],
    }];
  }
  return Array.from({ length: count }, (_, i) => ({
    title: section.answerLabel(i),
    kicker: "みなさんの回答",
    navLabel: String(i + 1),
    choices: section.choices,
    pick: (stats) => stats?.[section.id]?.[String(i + 1)],
  }));
});

const state = {
  view: 0,      // VIEWS の添字
  stats: null,  // 最後に取得できた集計（取得に失敗しても消さない）
  rows: [],     // いま画面にある棒: { choice, fill, count, pct }
};

/* ===== 数字と棒の表示 ===== */

/** 数字を前の値から新しい値へなめらかに動かす。 */
function tweenNumber(el, to) {
  const from = Number(el.dataset.value || 0);
  el.dataset.value = String(to);
  cancelAnimationFrame(Number(el.dataset.raf || 0));
  if (from === to) {
    el.textContent = String(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / 600, 1);
    el.textContent = String(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
    if (t < 1) el.dataset.raf = String(requestAnimationFrame(step));
  };
  el.dataset.raf = String(requestAnimationFrame(step));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** ビューの選択肢に合わせて棒の行を作り直す（幅 0 から伸びる）。 */
function buildRows(view) {
  const bars = $("bars");
  bars.style.setProperty("--rows", String(view.choices.length));
  state.rows = view.choices.map((choice) => {
    const row = el("div", "bar-row");
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    track.appendChild(fill);
    const countBox = el("div", "bar-count");
    const count = el("span", "", "0");
    const pct = el("small", "bar-pct", "");
    countBox.append(count, el("small", "", "人"), pct);
    row.append(el("div", "bar-label", choice), track, countBox);
    return { choice, row, fill, count, pct };
  });
  bars.replaceChildren(...state.rows.map((r) => r.row));
  void bars.offsetWidth; // 幅 0 の状態を一度描かせてから伸ばす
}

/** いまのビューの人数を画面に反映する。 */
function renderStats() {
  const view = VIEWS[state.view];
  const counts = view.pick(state.stats) || {};
  const values = view.choices.map((choice) => Math.max(Number(counts[choice]) || 0, 0));
  const sum = values.reduce((a, b) => a + b, 0);
  const max = Math.max(...values, 1);
  // total が無い・おかしい場合は選択肢の合計を使う
  const total = Number.isFinite(Number(counts.total)) ? Number(counts.total) : sum;

  state.rows.forEach((row, i) => {
    row.fill.style.width = (values[i] / max) * 100 + "%"; // いちばん多い選択肢を端までの長さにする
    tweenNumber(row.count, values[i]);
    row.pct.textContent = sum > 0 ? Math.round((values[i] / sum) * 100) + "%" : "";
  });
  tweenNumber($("total"), total);
}

function showView(index) {
  state.view = Math.min(Math.max(index, 0), VIEWS.length - 1);
  const view = VIEWS[state.view];
  $("view-title").textContent = view.title;
  $("view-kicker").textContent = view.kicker;
  [...$("nav").children].forEach((b, i) => {
    b.classList.toggle("current", i === state.view);
    b.setAttribute("aria-pressed", String(i === state.view));
  });
  buildRows(view);
  renderStats();
  // 再読み込みしても同じ問題に戻れるよう、URL に残す
  history.replaceState(null, "", "#" + (state.view + 1));
}

/* ===== 切り替え（ボタンとキーボード） ===== */

function initNav() {
  $("nav").replaceChildren(
    ...VIEWS.map((view, i) => {
      const b = el("button", "", view.navLabel);
      b.type = "button";
      b.title = view.title;
      b.addEventListener("click", () => {
        showView(i);
        b.blur(); // ボタンにフォーカスが残ると、Space/Enter で意図せず押されるため
      });
      return b;
    })
  );

  const tenth = VIEWS.findIndex((v) => v.navLabel === "10"); // 0 キー = 第10問
  const pred = VIEWS.length - 1; // P キー = 最後のビュー（以心伝心ゲーム予想）

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") showView(state.view + 1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") showView(state.view - 1);
    else if (/^[1-9]$/.test(e.key)) showView(Number(e.key) - 1);
    else if (e.key === "0" && tenth >= 0) showView(tenth);
    else if (e.key === "p" || e.key === "P") showView(pred);
    else if (e.key === "f" || e.key === "F") toggleFullscreen();
    else return;
    e.preventDefault();
  });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

/* ===== 集計の取得 ===== */

/** 取得した JSON が想定の形かを確かめる（HTML のエラーページなどを弾く）。 */
function checkStats(stats) {
  if (!stats || typeof stats !== "object" || typeof stats.quiz !== "object" || typeof stats.pred !== "object") {
    throw new Error("unexpected response");
  }
  return stats;
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
    const res = await fetch(withParams(url, { t: Date.now() }), {
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
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
    const name = "__wgStats" + ++jsonpSeq;
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
    script.src = withParams(url, { callback: name, t: Date.now() });
    document.head.appendChild(script);
  });
}

function withParams(url, params) {
  const u = new URL(url);
  Object.entries(params).forEach(([key, value]) => u.searchParams.set(key, String(value)));
  return u.toString();
}

/* ===== デモ（?demo=1）: ダミーの人数が少しずつ増える ===== */

const DEMO_GUESTS = 60;

// 本物と同じ形の集計を 0 人から作っておく。各ビューの人数（counts）は demoCounts からも参照する
const demoStats = {};
const demoCounts = SECTIONS.flatMap((section) => {
  const count = section.form.answerEntries.length;
  const blank = () => Object.fromEntries([...section.choices.map((c) => [c, 0]), ["total", 0]]);
  if (count === 1) return [{ choices: section.choices, counts: (demoStats[section.id] = blank()) }];
  demoStats[section.id] = {};
  return Array.from({ length: count }, (_, i) => ({
    choices: section.choices,
    counts: (demoStats[section.id][String(i + 1)] = blank()),
  }));
});

function loadDemo() {
  demoCounts.forEach(({ choices, counts }, seed) => {
    // 問題ごとに選ばれやすさを変えて、棒の長さに差が出るようにする
    const weights = choices.map((_, i) => 1 + ((seed * 7 + i * 5) % 6));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const add = Math.min(Math.floor(Math.random() * 4), DEMO_GUESTS - counts.total);
    for (let n = 0; n < add; n++) {
      let r = Math.random() * weightSum;
      const i = weights.findIndex((w) => (r -= w) < 0);
      counts[choices[Math.max(i, 0)]] += 1;
      counts.total += 1;
    }
  });
  return Promise.resolve({ updatedAt: new Date().toISOString(), ...structuredClone(demoStats) });
}

/* ===== 定期更新 ===== */

function formatTime(value) {
  const d = new Date(value);
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function setError(message) {
  $("badge-error").textContent = message || "";
  $("badge-error").classList.toggle("hidden", !message);
}

async function poll(load) {
  try {
    state.stats = checkStats(await load());
    $("updated").textContent = "最終更新 " + formatTime(state.stats.updatedAt);
    // Code.gs 側の設定ミス（タブ名の間違いなど）は errors で届く。名前は含まれない
    setError(Array.isArray(state.stats.errors) && state.stats.errors.length > 0 ? "設定エラー: " + state.stats.errors.join(" / ") : "");
    renderStats();
  } catch (e) {
    // 失敗しても前回の数字は表示したままにして、次の回でまた試す
    setError("通信エラー（再試行中）");
  }
  // 前の取得が終わってから次を予約する（応答が遅いときに取得が重ならないように）
  setTimeout(() => poll(load), HOST.pollMs);
}

/* ===== 起動 ===== */

initNav();
showView((Number.parseInt(location.hash.slice(1), 10) || 1) - 1);

if (DEMO) {
  $("badge-demo").classList.remove("hidden");
  poll(loadDemo);
} else if (!HOST.statsUrl) {
  $("setup").classList.remove("hidden");
  $("bars").classList.add("hidden");
} else {
  const load = HOST.transport === "jsonp" ? loadViaJsonp : loadViaFetch;
  poll(() => load(HOST.statsUrl, HOST.timeoutMs));
}
