/*
 * 司会画面の「ランキング」のスライドの進み方（js/ranking.js）と、デモ・仮のスライドのテスト。
 *
 *   node --test js/test/ranking.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  RANK_START, RANK_DEFAULT_LIMIT, RANK_MAX_LIMIT, RANK_LIST_HEIGHT,
  rankLimitOf, rankGroups, normalizeRanking, rankSteps, rankShown, stepRank, rankNote, placeLabel, scoreLabel, cutoffLabel, rankLayout,
} = await import("../ranking.js");
const { nameScale } = await import("../pred-result.js");
const { panelSlides } = await import("../host-panel.js");
const { createDemoBackend } = await import("../host-demo.js");
const { HOST } = await import("../config.js");

/** 正解数の一覧から、架空の人（「人1」「人2」…）を作る。 */
const people = (scores) => scores.map((score, i) => ({ name: "人" + (i + 1), score }));
/** Apps Script の応答の形。 */
const response = (scores, limit = 5, answered = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) => ({ updatedAt: "x", ...rankGroups(people(scores), limit), answered });
const ok = (scores, limit) => ({ status: "ok", data: normalizeRanking(response(scores, limit)) });
const SEVEN = [9, 8, 8, 7, 7, 7, 5];

test("success: rankLimitOf は 1〜30 の整数だけを受け付ける（それ以外は 5）", () => {
  const tests = {
    "success: 5": [5, 5],
    "success: 1": [1, 1],
    "success: 30": [30, 30],
    "success: 0 は範囲外": [0, RANK_DEFAULT_LIMIT],
    "success: 31 は範囲外": [31, RANK_DEFAULT_LIMIT],
    "success: 小数": [2.5, RANK_DEFAULT_LIMIT],
    "success: 文字列": ["3", RANK_DEFAULT_LIMIT],
    "success: 未設定": [undefined, RANK_DEFAULT_LIMIT],
    "success: NaN": [NaN, RANK_DEFAULT_LIMIT],
  };
  for (const [name, [value, want]] of Object.entries(tests)) assert.equal(rankLimitOf(value), want, name);
  assert.equal(RANK_MAX_LIMIT, 30);
  assert.equal(rankLimitOf(HOST.rankingLimit), HOST.rankingLimit); // 設定値は有効な値になっている
});

test("success: rankGroups は同点を同じ順位にし、景品の数をまたぐ組を cutoff にする", () => {
  const tests = {
    "success: [9,8,8,7,7,7,5]・5つ → 1位(1) 2位(2) 4位(3)。残り2枠": [SEVEN, 5, [[1, 9, 1], [2, 8, 2], [4, 7, 3]], [4, 2]],
    "success: ちょうど届く": [SEVEN, 3, [[1, 9, 1], [2, 8, 2]], null],
    "success: 2位の同点が 2つをまたぐ": [SEVEN, 2, [[1, 9, 1], [2, 8, 2]], [2, 1]],
    "success: 人数より多い": [SEVEN, 30, [[1, 9, 1], [2, 8, 2], [4, 7, 3], [7, 5, 1]], null],
    "success: 全員が同点": [[4, 4, 4], 2, [[1, 4, 3]], [1, 2]],
    "success: 0問正解は枠が余っていれば入る": [[3, 0, 0], 5, [[1, 3, 1], [2, 0, 2]], null],
    "success: 誰もいない": [[], 5, [], null],
  };
  for (const [name, [scores, limit, wantGroups, wantCutoff]] of Object.entries(tests)) {
    const res = rankGroups(people(scores), limit);
    assert.deepEqual(res.groups.map((g) => [g.place, g.score, g.names.length]), wantGroups, name);
    assert.deepEqual(res.cutoff ? [res.cutoff.place, res.cutoff.slots] : null, wantCutoff, name);
    assert.deepEqual([res.total, res.limit], [scores.length, limit], name);
  }
  // 組の中は日本語の並び順
  const names = rankGroups([{ name: "たなか", score: 1 }, { name: "あいだ", score: 1 }, { name: "さとう", score: 1 }], 5).groups[0].names;
  assert.deepEqual(names, ["あいだ", "さとう", "たなか"]);
});

test("success: normalizeRanking は応答を、上の順位から並べた組にする", () => {
  const data = normalizeRanking(response(SEVEN));
  assert.deepEqual([data.total, data.limit, data.answered.length], [7, 5, 10]);
  assert.deepEqual(data.rows.map((row) => [row.place, row.score, row.names.length, row.cutoff, row.slots]), [
    [1, 9, 1, false, 1],
    [2, 8, 2, false, 2],
    [4, 7, 3, true, 2],
  ]);
  // 並びがばらばらでも順位の順にする / 名前は前後の空白を除き、文字列でないものは捨てる / 名前のない組は捨てる
  const messy = normalizeRanking({
    total: 1,
    limit: 5,
    answered: [1, "2", 0, 3],
    groups: [{ place: 2, score: 3, names: [" 山田 ", "", null, 5] }, { place: 1, score: 4, names: ["佐藤"] }, { place: 3, score: 0, names: [""] }],
    cutoff: null,
  });
  assert.deepEqual(messy.rows.map((row) => [row.place, ...row.names]), [[1, "佐藤"], [2, "山田"]]);
  assert.deepEqual(messy.answered, [1, 3]);
  assert.equal(messy.total, 2); // 人数は、名前の数より小さくならない
  // 誰も答えていない
  assert.deepEqual(normalizeRanking({ total: 0, limit: 5, answered: [1], groups: [], cutoff: null }).rows, []);
});

test("success: normalizeRanking は、枠の数がおかしい cutoff をじゃんけんの組にしない", () => {
  const base = { total: 3, limit: 2, answered: [1], groups: [{ place: 1, score: 2, names: ["あ", "い", "う"] }] };
  const tests = {
    "success: 正しい cutoff": [{ place: 1, slots: 2, names: [] }, [true, 2]],
    "success: 枠が人数と同じ": [{ place: 1, slots: 3 }, [false, 3]],
    "success: 枠が 0": [{ place: 1, slots: 0 }, [false, 3]],
    "success: 枠が小数": [{ place: 1, slots: 1.5 }, [false, 3]],
    "success: 順位が合わない": [{ place: 2, slots: 1 }, [false, 3]],
    "success: null": [null, [false, 3]],
    "success: 文字列": ["oops", [false, 3]],
  };
  for (const [name, [cutoff, want]] of Object.entries(tests)) {
    const row = normalizeRanking({ ...base, cutoff }).rows[0];
    assert.deepEqual([row.cutoff, row.slots], want, name);
  }
});

test("failed: normalizeRanking は想定外の応答（古い Code.gs の人数の JSON など）を null にする", () => {
  const tests = {
    "failed: 人数の JSON": { updatedAt: "x", quiz: {}, pred: { total: 3 } },
    "failed: groups が配列でない": { limit: 5, groups: "x" },
    "failed: limit がない": { groups: [] },
    "failed: limit が 0": { limit: 0, groups: [] },
    "failed: 組の順位がない": { limit: 5, groups: [{ score: 1, names: ["あ"] }] },
    "failed: 組の正解数が負": { limit: 5, groups: [{ place: 1, score: -1, names: ["あ"] }] },
    "failed: 組の名前が配列でない": { limit: 5, groups: [{ place: 1, score: 1, names: "あ" }] },
    "failed: 組が null": { limit: 5, groups: [null] },
    "failed: null": null,
    "failed: 文字列": "oops",
  };
  for (const [name, data] of Object.entries(tests)) assert.equal(normalizeRanking(data), null, name);
});

test("success: → で下の順位から1組ずつ映し、1位のあとの → で次のスライドへ（← で1つずつ戻る）", () => {
  const ranking = ok(SEVEN); // 3組
  assert.equal(rankSteps(ranking), 3);
  let rank = RANK_START;
  assert.equal(rankShown(rank, ranking), 0);

  for (const shown of [1, 2, 3]) {
    const result = stepRank(rank, "advance", ranking);
    assert.deepEqual(result, { rank: { shown }, leave: null });
    rank = result.rank;
  }
  // 1位まで映したら、次の → で次のスライドへ（表示はそのまま）
  assert.deepEqual(stepRank(rank, "advance", ranking), { rank: { shown: 3 }, leave: "next" });

  for (const shown of [2, 1, 0]) {
    const result = stepRank(rank, "retreat", ranking);
    assert.deepEqual(result, { rank: { shown }, leave: null });
    rank = result.rank;
  }
  assert.deepEqual(stepRank(rank, "retreat", ranking), { rank: RANK_START, leave: "prev" });
  // 知らない操作では何も変わらない
  assert.deepEqual(stepRank({ shown: 1 }, "jump", ranking), { rank: { shown: 1 }, leave: null });
});

test("success: 次のスライドから ← で戻ってきたら、全員を映した続きから", () => {
  assert.deepEqual(stepRank(RANK_START, "return", ok(SEVEN)).rank, { shown: 3 });
  assert.deepEqual(stepRank({ shown: 1 }, "return", ok([3, 2])).rank, { shown: 2 });
  assert.deepEqual(stepRank({ shown: 3 }, "return", { status: "nokey" }).rank, { shown: 0 });
});

test("success: 順位を取得中は → で進まない。取得できないときは、そのまま次のスライドへ進める", () => {
  assert.deepEqual(stepRank(RANK_START, "advance", { status: "loading" }), { rank: RANK_START, leave: null });
  assert.equal(stepRank(RANK_START, "retreat", { status: "loading" }).leave, "prev");
  for (const ranking of [null, { status: "nokey" }, { status: "unsupported" }, { status: "error" }, { status: "failed", message: "x" }]) {
    assert.equal(rankSteps(ranking), 0);
    assert.deepEqual(stepRank(RANK_START, "advance", ranking), { rank: RANK_START, leave: "next" });
    assert.equal(stepRank(RANK_START, "retreat", ranking).leave, "prev");
    // 発表の途中で映せなくなったら、スライドだけの表示に戻る
    assert.equal(rankShown({ shown: 2 }, ranking), 0);
    assert.equal(stepRank({ shown: 2 }, "advance", ranking).leave, "next");
  }
});

test("success: 誰も答えていないときは、その知らせを1段だけ映す", () => {
  const ranking = ok([]);
  assert.equal(rankSteps(ranking), 1);
  assert.deepEqual(stepRank(RANK_START, "advance", ranking), { rank: { shown: 1 }, leave: null });
  assert.equal(stepRank({ shown: 1 }, "advance", ranking).leave, "next");
  assert.deepEqual(stepRank({ shown: 1 }, "retreat", ranking), { rank: RANK_START, leave: null });
});

test("success: 司会者への知らせ（順位を映せない理由・採点していない問題）", () => {
  assert.equal(rankNote({ status: "nokey" }, 10), "ランキングを表示するには司会キーが必要です");
  assert.equal(rankNote({ status: "unsupported" }, 10), "ランキングを表示するには Apps Script を更新してください");
  assert.match(rankNote({ status: "error" }, 10), /ランキングを取得できません/);
  assert.equal(rankNote({ status: "failed", message: "正解を読めません: タブ「正解」が見つかりません" }, 10), "ランキングを表示できません: 正解を読めません: タブ「正解」が見つかりません");
  assert.equal(rankNote({ status: "failed" }, 10), "ランキングを表示できません: 不明なエラー");
  assert.equal(rankNote({ status: "loading" }, 10), "ランキングを集計中…");
  assert.equal(rankNote(null, 10), "");
  assert.equal(rankNote(ok(SEVEN), 10), "");
  // 「正解」タブに書かれていない問題
  const partial = { status: "ok", data: normalizeRanking(response(SEVEN, 5, [1, 2, 3, 5, 6, 7, 8, 10])) };
  assert.equal(rankNote(partial, 10), "正解が未設定の問題は採点していません: 第4問・第9問");
});

test("success: 順位・正解数・じゃんけんの表示", () => {
  assert.equal(placeLabel(1), "1位");
  assert.equal(placeLabel(10), "10位");
  assert.equal(scoreLabel(8), "8問正解");
  assert.equal(scoreLabel(0), "0問正解");
  const cut = normalizeRanking(response(SEVEN)).rows.at(-1);
  assert.equal(cutoffLabel(cut), "同点 3名 → じゃんけんで 2名");
  assert.equal(cutoffLabel(normalizeRanking(response([4, 4, 4, 4, 4, 4], 5)).rows[0]), "同点 6名 → じゃんけんで 5名");
});

test("success: rankLayout は 1920×1080 に収まる並べ方を選ぶ", () => {
  const rowsOf = (scores, limit) => normalizeRanking(response(scores, limit)).rows;
  const twenty = [10, 9, 9, 8, 8, 8, 7, 7, 7, 7, 6, 6, 6, 5, 5, 4, 4, 3, 2, 0];
  const cases = {
    "success: 1人": rowsOf([5], 5),
    "success: 5人が別々の順位": rowsOf([9, 8, 7, 6, 5, 4], 5),
    "success: 1位(1) 2位(2) 4位(3)": rowsOf(SEVEN, 5),
    "success: 5位が 6人の同点": rowsOf([9, 8, 7, 6, 5, 5, 5, 5, 5, 5], 5),
    "success: 20人が全員同点": rowsOf(Array(20).fill(3), 5),
    "success: 1位の下が 15人の同点": rowsOf([9, ...Array(15).fill(4)], 5),
    "success: 5位が 12人の同点": rowsOf([9, 8, 7, 6, ...Array(12).fill(5)], 5),
    "success: 30人が全員同点": rowsOf(Array(30).fill(0), 5),
  };
  // 組が 7つ以上あると（景品の数を増やしたとき）見積もりでは収まらない。そのときは画面側（js/host.js）が全体を縮める
  // （いちばん低い並べ方と高さがほぼ同じもののうち、文字が大きいものを選ぶ）
  const crowded = rankLayout(rowsOf(twenty, 20));
  assert.ok(crowded.height > RANK_LIST_HEIGHT);
  assert.deepEqual([crowded.columns, crowded.font], [4, 4.6]);
  for (const [name, rows] of Object.entries(cases)) {
    const layout = rankLayout(rows);
    assert.ok(layout.height <= RANK_LIST_HEIGHT, name + " 縦 " + layout.height);
    assert.ok(layout.columns * layout.width + (layout.columns - 1) * 1.4 <= 108.01, name + " 横");
    assert.ok(layout.fit >= 4.2, name + " 全角4文字は縮めずに収まる");
  }
  // 人数が少なければ大きい文字、多ければ小さい文字
  assert.deepEqual([rankLayout(cases["success: 1位(1) 2位(2) 4位(3)"]).columns, rankLayout(cases["success: 1位(1) 2位(2) 4位(3)"]).font], [3, 5.6]);
  assert.ok(rankLayout(cases["success: 30人が全員同点"]).font < rankLayout(cases["success: 5位が 6人の同点"]).font);
  assert.ok(rankLayout([]).height <= RANK_LIST_HEIGHT);
  // 長い名前は、その枠だけ縮める
  const { fit } = rankLayout(cases["success: 1位(1) 2位(2) 4位(3)"]);
  assert.equal(nameScale("山田 太郎", fit), 1);
  assert.ok(nameScale("勅使河原 ゆきのじょう", fit) < 1);
});

test("success: 仮のスライドの最後に、ランキングと 2位・1位の景品のスライドがある", () => {
  const slides = panelSlides();
  assert.deepEqual(slides.slice(-3).map((s) => [s.kind, s.place ?? null]), [["ranking", null], ["prize", 2], ["prize", 1]]);
  assert.equal(slides.filter((s) => s.kind === "ranking").length, 1);
  assert.equal(new Set(slides.map((s) => s.objectId)).size, slides.length);
  for (const slide of slides.slice(-3)) assert.match(slide.imageUrl, /^data:image\/svg\+xml/);
});

test("success: デモはランキングのスライドと、同点のじゃんけんを含む架空の成績を返す", async () => {
  const demo = createDemoBackend();
  const { slides } = await demo.loadSlides();
  const kinds = slides.map((s) => s.kind);
  assert.equal(kinds.filter((kind) => kind === "ranking").length, 1);
  assert.ok(kinds.indexOf("ranking") > kinds.indexOf("predResult")); // 予想結果より後ろ
  assert.equal(kinds.indexOf("predResult"), 9); // 予想結果は host.html?demo=1#s10 のまま

  const data = await demo.loadRanking(5); // js/host-api.js の fetchRanking と同じ形（normalizeRanking の結果）
  assert.deepEqual(data.rows.map((row) => [row.place, row.score, row.names.length, row.cutoff, row.slots]), [
    [1, 9, 1, false, 1],
    [2, 8, 2, false, 2],
    [4, 7, 3, true, 2],
  ]);
  assert.equal(data.total, 24);
  assert.equal(data.answered.length, 10);
  assert.equal(rankNote({ status: "ok", data }, 10), "");
  const names = data.rows.flatMap((row) => row.names);
  assert.equal(new Set(names).size, names.length);
  // 景品の数を変えても、同じ形で返る
  assert.equal((await demo.loadRanking(1)).rows.length, 1);
  assert.equal((await demo.loadRanking(30)).rows.reduce((sum, row) => sum + row.names.length, 0), 24);
});

test("failed: デモは範囲外の limit を受け付けない", async () => {
  const demo = createDemoBackend();
  for (const limit of [0, 31, 1.5, "5", undefined]) await assert.rejects(demo.loadRanking(limit), { code: "bad_request" });
});
