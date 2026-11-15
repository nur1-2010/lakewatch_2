// Форматирование чисел, площадей и дат по правилам выбранного языка.
import { locale, t } from "./i18n.js";

// В казахском числа пишутся как в русском (пробел между разрядами, запятая в дробях),
// но не все браузеры знают это для kk-KZ, поэтому числа для казахского форматируем по ru-RU.
const numberLocale = () => (locale() === "kk-KZ" ? "ru-RU" : locale());

export function number(value, digits = 0) {
  return new Intl.NumberFormat(numberLocale(), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

// Площади до 0,1 км² показываем в м², крупнее — в км².
export function area(m2) {
  if (m2 === null || m2 === undefined || Number.isNaN(m2)) return "—";
  if (Math.abs(m2) >= 100_000) return `${number(m2 / 1e6, 2)} ${t("units.km2")}`;
  return `${number(Math.round(m2 / 10) * 10)} ${t("units.m2")}`;
}

export function date(iso) {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

export function shortDate(iso) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
}

export function pct(value) {
  if (value === null || value === undefined) return "—";
  // очень большой рост («+3000%») читается плохо: показываем «×31»
  if (value > 400) return `×${number(value / 100 + 1, value < 900 ? 1 : 0)}`;
  const rounded = Math.round(value);          // сначала округляем, чтобы не получить «−0%»
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${number(Math.abs(rounded))}%`;
}

// Объём: до 1 млн м³ — в тысячах, округлённо (оценка грубая, лишние цифры вводили бы в заблуждение).
export function volume(m3) {
  if (m3 === null || m3 === undefined) return "—";
  const rounded = m3 >= 100_000 ? Math.round(m3 / 10_000) * 10_000 : m3 >= 10_000 ? Math.round(m3 / 1000) * 1000 : Math.round(m3 / 100) * 100;
  return `${number(rounded)} ${t("units.m3")}`;
}

// Название месяца по номеру (1–12) на текущем языке.
export function monthName(m) {
  return new Intl.DateTimeFormat(locale(), { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, m - 1, 15)));
}

// Какие параметры сообщений — площади, какие — даты (см. ключи в i18n/*.json).
const AREA_PARAMS = ["area", "normal", "from", "to", "rate", "first_area", "last_area", "prev_area"];
const DATE_PARAMS = ["date", "date_from", "date_to"];

export const messageFormatters = Object.fromEntries([
  ...AREA_PARAMS.map((k) => [k, area]),
  ...DATE_PARAMS.map((k) => [k, date]),
  ["pct", (v) => number(v)],
  ["ratio", (v) => number(v, 1)],
  ["count", (v) => number(v)],
  ["pixels", (v) => number(v)],
  ["days", (v) => number(v)],
  ["volume", volume],
  ["month", monthName],
  ["low_month", monthName],
]);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
