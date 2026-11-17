/*
 * 司会画面の「仮のスライド」。Google スライドを映せないとき（司会キーがない、?panel=1、取得に失敗）と、
 * デモ表示（?demo=1）で、スライドの代わりに映す。問題ごとに1枚ずつ、その場で作った画像（SVG）を使う。
 */
import { ALL_TARGETS, parseTarget } from "./gate.js";

const escapeXml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** 題名と説明だけのスライド画像（16:9）を data URL で作る。 */
export function placeholderImage(title, sub, foot = "") {
  const font = `font-family="'Hiragino Mincho ProN','Yu Mincho',serif" text-anchor="middle"`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">` +
    `<rect width="1600" height="900" fill="#123528"/>` +
    `<rect x="36" y="36" width="1528" height="828" fill="none" stroke="#c9a227" stroke-width="3"/>` +
    `<text x="800" y="380" ${font} font-size="120" fill="#f7f3e8">${escapeXml(title)}</text>` +
    `<text x="800" y="490" ${font} font-size="46" fill="#e8cf7a">${escapeXml(sub)}</text>` +
    `<text x="800" y="120" ${font} font-size="28" fill="#e8cf7a" opacity=".7">${escapeXml(foot)}</text>` +
    `</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/** 対象（"q5" / "pred"）を、スライド一覧の1件の形にする。 */
export function targetSlide(target, objectId, imageUrl) {
  const { section, index } = parseTarget(target);
  return section.id === "quiz"
    ? { objectId, kind: "question", question: index + 1, imageUrl }
    : { objectId, kind: "prediction", imageUrl };
}

/** 予想の結果を発表するスライド（そろった数と、的中した人の名前を重ねて映す）の、スライド一覧の1件。 */
export function predResultSlide(objectId, foot = "") {
  return { objectId, kind: "predResult", imageUrl: placeholderImage("予想結果", "新郎新婦の答えは 何問そろったでしょう？", foot) };
}

/** クイズの成績を発表するスライド（正解数の多い順に名前を重ねて映す）の、スライド一覧の1件。 */
export function rankingSlide(objectId, foot = "") {
  return { objectId, kind: "ranking", imageUrl: placeholderImage("クイズ ランキング", "成績上位のみなさまを発表します", foot) };
}

/** 第1問〜第10問と予想、予想結果、ランキングを、1枚ずつ仮のスライドにした一覧（本物のスライド一覧と同じ形）。 */
export function panelSlides() {
  const slides = ALL_TARGETS.map((target) => {
    const { section, index } = parseTarget(target);
    const title = section.id === "quiz" ? section.answerLabel(index) : section.title;
    return targetSlide(target, "panel-" + target, placeholderImage(title, section.promptLines.join(" ")));
  });
  return [...slides, predResultSlide("panel-predResult"), rankingSlide("panel-ranking")];
}
