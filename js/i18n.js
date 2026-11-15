// Переводы интерфейса: русский, казахский, английский.
// Язык выбирается так: ?lang= в адресе → сохранённый выбор → язык браузера → русский.

export const LANGS = ["kk", "ru", "en"];
const LOCALES = { ru: "ru-RU", kk: "kk-KZ", en: "en-GB" };
const STORAGE_KEY = "lakewatch.lang";

let lang = "ru";
let dict = {};
const cache = {};

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* приватный режим — не страшно */ }
}

export function detectLang() {
  const fromUrl = new URLSearchParams(location.search).get("lang");
  if (LANGS.includes(fromUrl)) return fromUrl;
  const saved = safeGet(STORAGE_KEY);
  if (LANGS.includes(saved)) return saved;
  for (const l of navigator.languages || [navigator.language || ""]) {
    const code = l.slice(0, 2).toLowerCase();
    if (LANGS.includes(code)) return code;
  }
  return "ru";
}

export async function setLang(next) {
  if (!cache[next]) {
    const resp = await fetch(`i18n/${next}.json`);
    if (!resp.ok) throw new Error(`i18n ${next}: ${resp.status}`);
    cache[next] = await resp.json();
  }
  lang = next;
  dict = cache[next];
  safeSet(STORAGE_KEY, next);
  document.documentElement.lang = next;
  document.title = dict["app.title"] || document.title;
  return next;
}

export const currentLang = () => lang;
export const locale = () => LOCALES[lang];

// Перевод по ключу. Параметры подставляются в {скобки}; formatters превращают значения в текст.
export function t(key, params = {}, formatters = {}) {
  const template = dict[key] ?? cache.ru?.[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in params)) return `{${name}}`;
    const fmt = formatters[name];
    return fmt ? fmt(params[name]) : String(params[name]);
  });
}

// Перевести все элементы страницы с атрибутом data-i18n.
export function translateStatic(root = document, params = {}) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n, params);
  });
}
