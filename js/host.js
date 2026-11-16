/*
 * 司会画面（host.html）。会場のスクリーンに映す。動き方は2つある。
 *
 * 1. スライドショー（司会キーがあるとき / ?demo=1）
 *    Google スライドを1枚ずつ画像で映し、→ / クリックで進める。
 *    「第N問 回答数」「予想 回答数」のスライドだけは、画像の代わりにリアルタイムの回答数グラフを映す。
 *    どのスライドがグラフかは Apps Script（apps-script/Code.gs）がスライド上の文字で判定して返す。
 *    操作: → ↓ Space Enter PageDown クリック（次へ）、← ↑ Backspace PageUp（前へ）、Home / End、
 *          R（スライドを読み直す）、F（全画面）。
 *
 * 2. グラフだけ（司会キーがないとき / ?chart=1 / スライドを取得できないとき）
 *    問題を選んで、その回答数グラフだけを映す（スライドは別のウィンドウで映す使い方）。
 *    操作: 下のボタン、← / →（前後）、1〜9・0（第1〜9問・第10問）、P（予想）、F（全画面）。
 *
 * 集計は Apps Script が返す JSON を読むだけで、Google フォームへは何も送らない。名前は届かない（人数だけ）。
 *
 *   { updatedAt, quiz: { "1": {A,B,C,D,total}, …, "10": {…} }, pred: { "0問": n, …, "5問": n, total } }
 *
 * 【将来の正解発表について】いまは人数の表示だけ。足すときは、Code.gs が「正解」タブを読んで
 * JSON に正解を含め、renderStats() で該当する行に .correct、それ以外に .dimmed を付ければよい
 * （スタイルは css/host.css に用意済み）。
 */
import { SECTIONS, HOST } from "./config.js";
import { takeHostKey, fetchStats, fetchSlideList } from "./host-api.js";
import { loadDemoStats, loadDemoSlides } from "./host-demo.js";

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const DEMO = query.get("demo") === "1";
const CHART_ONLY = query.get("chart") === "1";
const hostKey = takeHostKey(); // URL の ?key=… はここで保存して、アドレスバーから消す
// 再読み込み前の位置。"#3" = グラフだけの画面の第3問、"#s12" = スライドショーの12枚目
const startHash = location.hash;

const netOptions = { timeoutMs: HOST.timeoutMs, transport: HOST.transport };

/** 集計の取得方法。null なら未設定。 */
const loadStats = DEMO ? loadDemoStats : HOST.statsUrl ? () => fetchStats(HOST.statsUrl, netOptions) : null;

/** スライド一覧の取得方法。null ならスライドショーを使わない（グラフだけの画面になる）。 */
const loadSlides = CHART_ONLY
  ? null
  : DEMO
    ? loadDemoSlides
    : HOST.statsUrl && hostKey
      ? (refresh) => fetchSlideList(HOST.statsUrl, hostKey, refresh, { ...netOptions, timeoutMs: HOST.slidesTimeoutMs })
      : null;

/*
 * グラフの表示単位（ビュー）。クイズは1問ごと、予想は1つ。config.js の SECTIONS から作るので、
 * 問題数や選択肢を変えてもここは直さなくてよい。pick は集計 JSON からそのビューの人数を取り出す。
 * kind / question は、スライド一覧の kind（"quizCounts" / "predCounts"）との対応付けに使う。
 */
const VIEWS = SECTIONS.flatMap((section) => {
  const count = section.form.answerEntries.length;
  if (count === 1) {
    return [{
      kind: section.id + "Counts",
      title: section.menuLabel,
      kicker: section.promptLines.join(""),
      navLabel: section.answerLabel(0),
      choices: section.choices,
      pick: (stats) => stats?.[section.id],
    }];
  }
  return Array.from({ length: count }, (_, i) => ({
    kind: section.id + "Counts",
    question: i + 1,
    title: section.answerLabel(i),
    kicker: "みなさんの回答",
    navLabel: String(i + 1),
    choices: section.choices,
    pick: (stats) => stats?.[section.id]?.[String(i + 1)],
  }));
});

const state = {
  view: 0,      // VIEWS の添字（いま出しているグラフ）
  stats: null,  // 最後に取得できた集計（取得に失敗しても消さない）
  rows: [],     // いま画面にある棒: { choice, fill, count, pct }
  slides: [],   // スライドショーのスライド: { objectId, kind, question, el, imageUrl, loaded, failed }
  slide: 0,     // slides の添字
  waitingForSlides: false, // 最初のスライド一覧を待っている間だけ true
  errors: { stats: "", slides: "" },
};

/** スライドショーとして動いているか（スライド一覧を取得できているか）。 */
const slideshow = () => state.slides.length > 0;

/** そのスライドがグラフのスライドなら VIEWS の添字、画像のスライドなら -1。 */
function viewIndexOf(slide) {
  if (!slide || slide.kind === "slide") return -1;
  return VIEWS.findIndex((v) => v.kind === slide.kind && (v.question === undefined || v.question === slide.question));
}

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

/** グラフを指定のビューに切り替える。 */
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
}

/** グラフだけの画面で、表示する問題を選ぶ。再読み込みしても同じ問題に戻れるよう URL に残す。 */
function selectView(index) {
  showView(index);
  history.replaceState(null, "", "#" + (state.view + 1));
}

/* ===== スライドショー ===== */

/** 画面の重なりを、いまの状態に合わせる（画像のスライドのときだけ、全面の画像でグラフを覆う）。 */
function updateStage() {
  const current = state.slides[state.slide];
  const onImage = slideshow() && viewIndexOf(current) < 0;
  document.body.classList.toggle("slideshow", slideshow());
  $("stage").classList.toggle("hidden", !(onImage || (!slideshow() && state.waitingForSlides)));
  state.slides.forEach((slide) => slide.el.classList.toggle("current", slide === current));
  $("stage-message").classList.toggle("hidden", onImage && current.loaded);
  $("stage-message").textContent = onImage && current.failed ? "スライドの画像を読み込めません（再試行中）" : "スライドを読み込み中…";
  $("slide-pos").textContent = slideshow() ? state.slide + 1 + " / " + state.slides.length : "";
}

function showSlide(index) {
  state.slide = Math.min(Math.max(index, 0), state.slides.length - 1);
  const view = viewIndexOf(state.slides[state.slide]);
  if (view >= 0) showView(view);
  updateStage();
  history.replaceState(null, "", "#s" + (state.slide + 1)); // 再読み込みしても同じスライドに戻る
  // 次の2枚は先に展開しておき、切り替えた瞬間に映るようにする（画像の取得自体は一覧を受け取った時点で全部始めている）
  state.slides.slice(state.slide + 1, state.slide + 3).forEach((slide) => {
    if (slide.loaded) slide.el.decode?.().catch(() => {});
  });
  kickPoll();
}

/**
 * スライド1枚の画像を読み込む。読み終わるまでは前の画像（あれば）を出したままにし、読めたら差し替える。
 * 読み込んだ <img> は画面に置いたままにするので、あとで画像の URL が期限切れになっても表示は消えない。
 */
function loadImage(slide, url) {
  slide.imageUrl = url;
  slide.failed = false;
  const img = el("img");
  img.alt = "";
  img.decoding = "async";
  img.draggable = false;
  img.onload = () => {
    if (slide.imageUrl !== url) return; // その後さらに新しい URL に変わっていた
    img.className = slide.el.className;
    slide.el.replaceWith(img);
    slide.el = img;
    slide.loaded = true;
    updateStage();
  };
  img.onerror = () => {
    if (slide.imageUrl !== url) return;
    // URL の期限切れなど。そのスライドの画像だけ作り直してもらう
    slide.failed = true;
    updateStage();
    scheduleSlides("", nextBackoff());
  };
  img.src = url;
}

/** 取得したスライド一覧を画面に反映する。スライドの増減・並べ替えがあっても、いまのスライドに留まる。 */
function applySlides(list) {
  const first = !slideshow();
  const currentId = state.slides[state.slide]?.objectId;
  const known = new Map(state.slides.map((slide) => [slide.objectId, slide]));
  const urls = new Map(list.map((item) => [item.objectId, item.imageUrl]));

  state.slides = list.map((item) => {
    const slide = known.get(item.objectId) || { objectId: item.objectId, el: Object.assign(el("img"), { alt: "" }), imageUrl: null, loaded: false, failed: false };
    slide.kind = item.kind;
    slide.question = item.question;
    return slide;
  });
  $("stage").replaceChildren($("stage-message"), ...state.slides.map((slide) => slide.el));

  let index = state.slides.findIndex((slide) => slide.objectId === currentId);
  if (index < 0) index = first ? (Number.parseInt(startHash.replace(/^#s/, ""), 10) || 1) - 1 : state.slide;
  index = Math.min(Math.max(index, 0), state.slides.length - 1);

  // いまのスライドから順に読み込みを始める（全部を先読みする）
  state.slides.forEach((_, i) => {
    const slide = state.slides[(index + i) % state.slides.length];
    const url = urls.get(slide.objectId);
    if (slide.kind === "slide" && url && url !== slide.imageUrl) loadImage(slide, url);
  });
  showSlide(index);
}

let slidesTimer = null;
let slidesBusy = false;
let slidesBackoff = 0;

/** 失敗が続くほど間隔をあける（5秒 → 10秒 → 20秒 → 30秒）。画像作りには回数制限があるため。 */
function nextBackoff() {
  slidesBackoff = Math.min((slidesBackoff || 2500) * 2, 30000);
  return slidesBackoff;
}

function scheduleSlides(mode, delay) {
  if (slidesTimer || slidesBusy) return; // 取得中なら、その取得が終わったときに改めて判断する
  slidesTimer = setTimeout(() => {
    slidesTimer = null;
    refreshSlides(mode);
  }, delay);
}

/**
 * スライド一覧を取得して反映する。mode が "all" なら Google 側のキャッシュも捨てて作り直す（R キー）。
 * それ以外は、読み込めなかった画像だけ作り直しを頼む。
 */
async function refreshSlides(mode) {
  if (!loadSlides || slidesBusy) return;
  clearTimeout(slidesTimer);
  slidesTimer = null;
  slidesBusy = true;
  let retry = null; // [mode, 待つミリ秒]
  try {
    const failedIds = state.slides.filter((slide) => slide.failed).map((slide) => slide.objectId);
    const res = await loadSlides(mode === "all" ? "all" : failedIds.join(","));
    if (res.slides.length === 0) throw Object.assign(new Error("スライドが1枚もありません"), { code: "empty" });
    applySlides(res.slides);
    const problems = Array.isArray(res.errors) ? res.errors : [];
    setError("slides", problems.join(" / "));
    // pending: Google 側でまだ画像を作れていないスライドがある。続きを取りに行く
    if (res.pending > 0) retry = ["", problems.length > 0 ? nextBackoff() : 1000];
  } catch (e) {
    // キー違い・未設定は、待っても直らないので再試行しない。それ以外（通信エラーなど）は間隔をあけて再試行する
    const fatal = e.code === "unauthorized" || e.code === "not_configured";
    setError("slides", e.code ? "スライド: " + e.message : "スライドを取得できません（再試行中）");
    if (!fatal) retry = [mode, nextBackoff()];
  } finally {
    slidesBusy = false;
    state.waitingForSlides = false;
    updateStage();
  }
  if (!retry) {
    // 取得中に読み込みに失敗した画像が残っていれば、もう一度頼む
    if (state.slides.some((slide) => slide.failed)) retry = ["", nextBackoff()];
    else slidesBackoff = 0;
  }
  if (retry) scheduleSlides(...retry);
}

/* ===== 切り替え（ボタン・キーボード・クリック） ===== */

function initNav() {
  $("nav").replaceChildren(
    ...VIEWS.map((view, i) => {
      const b = el("button", "", view.navLabel);
      b.type = "button";
      b.title = view.title;
      b.addEventListener("click", () => {
        selectView(i);
        b.blur(); // ボタンにフォーカスが残ると、Space/Enter で意図せず押されるため
      });
      return b;
    })
  );

  const tenth = VIEWS.findIndex((v) => v.navLabel === "10"); // 0 キー = 第10問
  const pred = VIEWS.length - 1; // P キー = 最後のビュー（以心伝心ゲーム予想）

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key;
    if (key === "f" || key === "F") toggleFullscreen();
    else if (slideshow()) {
      // プレゼン用リモコン（クリッカー）は PageDown / PageUp や → / ← を送る
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(key)) showSlide(state.slide + 1);
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(key)) showSlide(state.slide - 1);
      else if (key === "Home") showSlide(0);
      else if (key === "End") showSlide(state.slides.length - 1);
      else if (key === "r" || key === "R") refreshSlides("all");
      else return;
    } else if (key === "ArrowRight" || key === "PageDown") selectView(state.view + 1);
    else if (key === "ArrowLeft" || key === "PageUp") selectView(state.view - 1);
    else if (/^[1-9]$/.test(key)) selectView(Number(key) - 1);
    else if (key === "0" && tenth >= 0) selectView(tenth);
    else if (key === "p" || key === "P") selectView(pred);
    else return;
    e.preventDefault();
  });

  // スライドショー中は、画面のどこをクリックしても次へ進む
  document.addEventListener("click", (e) => {
    if (!slideshow() || e.target.closest("a, button")) return;
    showSlide(state.slide + 1);
  });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

/* ===== 集計の定期更新 ===== */

function formatTime(value) {
  const d = new Date(value);
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** 右下のエラー表示。集計（stats）とスライド（slides）を別々に持ち、まとめて出す。 */
function setError(source, message) {
  state.errors[source] = message || "";
  const text = Object.values(state.errors).filter(Boolean).join(" / ");
  $("badge-error").textContent = text;
  $("badge-error").classList.toggle("hidden", !text);
}

/**
 * いま集計を取りに行く必要があるか。グラフだけの画面では常に必要。
 * スライドショーでは、グラフのスライドを映している間と、その1枚手前にいる間だけ取りに行く
 * （手前から取っておくので、グラフに切り替えた瞬間から新しい数字が出る）。
 */
function wantsStats() {
  if (!slideshow()) return true;
  return [state.slide, state.slide + 1].some((i) => viewIndexOf(state.slides[i]) >= 0);
}

let pollTimer = null;
let pollBusy = false;

async function poll() {
  pollTimer = null;
  if (pollBusy || !loadStats || !wantsStats()) return; // 不要になったら止まる。kickPoll() でまた動き出す
  pollBusy = true;
  try {
    const stats = await loadStats();
    state.stats = stats;
    $("updated").textContent = "最終更新 " + formatTime(stats.updatedAt);
    // Code.gs 側の設定ミス（タブ名の間違いなど）は errors で届く。名前は含まれない
    setError("stats", Array.isArray(stats.errors) && stats.errors.length > 0 ? "設定エラー: " + stats.errors.join(" / ") : "");
    renderStats();
  } catch (e) {
    // 失敗しても前回の数字は表示したままにして、次の回でまた試す
    setError("stats", "通信エラー（再試行中）");
  } finally {
    pollBusy = false;
  }
  // 前の取得が終わってから次を予約する（応答が遅いときに取得が重ならないように）
  pollTimer = setTimeout(poll, HOST.pollMs);
}

/** 定期更新が止まっていれば動かす。 */
function kickPoll() {
  if (!pollBusy && !pollTimer) poll();
}

/* ===== 起動 ===== */

initNav();
if (startHash.startsWith("#s")) showView(0); // スライドショーの位置は、スライド一覧が届いてから復元する
else selectView((Number.parseInt(startHash.slice(1), 10) || 1) - 1);

if (DEMO) $("badge-demo").classList.remove("hidden");

if (!loadStats) {
  $("setup").classList.remove("hidden");
  $("bars").classList.add("hidden");
} else {
  kickPoll();
  if (loadSlides) {
    state.waitingForSlides = true;
    updateStage();
    refreshSlides("");
  }
}
