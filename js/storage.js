/*
 * localStorage の薄いラッパー。
 * プライベートブラウズや設定によっては localStorage へのアクセス自体が例外を投げるので、
 * すべて try/catch で包み、保存できなくてもページは動くようにする。
 */

const NAME_KEY = "wg_name";
const SENT_KEY = "wg_sent"; // { [名前]: { [セクションid]: { [問題番号(0始まり)]: 送信した回答 } } }

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    /* 保存できなくても続行する */
  }
}

function readSentMap() {
  try {
    const parsed = JSON.parse(read(SENT_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

export function loadName() {
  return read(NAME_KEY) || "";
}

export function saveName(name) {
  write(NAME_KEY, name);
}

/**
 * その名前で送信済みの回答を返す（例: { quiz: { "0": "A", "2": "C" }, pred: { "0": "3問" } }）。
 * 名前ごとに持つのは、同じ端末で別の人が名前を変えて答えるときに
 * 前の人の「送信済み」が引き継がれないようにするため。
 */
export function loadSent(name) {
  // 名前が "__proto__" などでも安全に引けるよう、自前のプロパティだけを見る
  const map = readSentMap();
  const entry = Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null;
  return entry && typeof entry === "object" ? entry : {};
}

export function saveSent(name, sent) {
  // map[name] = ... だと名前が "__proto__" のときに保存されないので、fromEntries で組み立てる
  const others = Object.entries(readSentMap()).filter(([key]) => key !== name);
  write(SENT_KEY, JSON.stringify(Object.fromEntries([...others, [name, sent]])));
}
