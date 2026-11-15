// Набор иконок в одном стиле (контур, толщина 2). Эмодзи как иконки не используются.
// Иконка рядом с текстом — декоративная, поэтому скрыта от экранных читалок (aria-hidden).
const PATHS = {
  "trending-up": '<path d="M22 7 13.5 15.5l-5-5L2 17"/><path d="M16 7h6v6"/>',
  "trending-down": '<path d="m22 17-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>',
  minus: '<path d="M5 12h14"/>',
  play: '<path d="M6 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L7.5 3.64A1 1 0 0 0 6 4.5z"/>',
  pause: '<rect x="5" y="4" width="5" height="16" rx="1.5"/><rect x="14" y="4" width="5" height="16" rx="1.5"/>',
  alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  plus: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  layers: '<path d="M12.8 2.2a2 2 0 0 0-1.6 0L2.6 6.1a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.6 0l8.6-3.9a1 1 0 0 0 0-1.8Z"/><path d="m2 12 9.2 4.2a2 2 0 0 0 1.6 0L22 12"/><path d="m2 17 9.2 4.2a2 2 0 0 0 1.6 0L22 17"/>',
  droplet: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.500-4-4-6.500c-.5 2.500-2 4.900-4 6.500C6 11.100 5 13 5 15a7 7 0 0 0 7 7z"/>',
  award: '<path d="m15.500 12.900 1.500 8.500a.5.5 0 0 1-.8.5l-3.600-2.700a1 1 0 0 0-1.200 0l-3.600 2.700a.5.5 0 0 1-.8-.5l1.500-8.500"/><circle cx="12" cy="8" r="6"/>',
  ruler: '<path d="M21.300 15.300a2.400 2.400 0 0 1 0 3.400l-2.600 2.600a2.400 2.400 0 0 1-3.400 0L2.700 8.700a2.410 2.410 0 0 1 0-3.400l2.600-2.600a2.410 2.410 0 0 1 3.400 0Z"/><path d="m14.500 12.500 2-2"/><path d="m11.500 9.500 2-2"/><path d="m8.500 6.500 2-2"/><path d="m17.500 15.500 2-2"/>',
};

export function icon(name, cls = "") {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name] || PATHS.info}</svg>`;
}

// Состояние озера всегда показывается и цветом, и иконкой, и текстом.
export const STATUS_ICON = {
  rapid_rise: "alert", rising: "trending-up", new_lake: "plus",
  stable: "check", falling: "trending-down", insufficient_data: "info",
};

// Иконка для вывода по его ключу (например "yoy.up" → стрелка вверх).
export function findingIcon(key) {
  if (key.startsWith("headline.")) return STATUS_ICON[key.split(".")[1]] || "info";
  if (/\.(up|grew)$/.test(key)) return "trending-up";
  if (/\.(down|shrank)$/.test(key)) return "trending-down";
  if (/\.flat$/.test(key)) return "minus";
  if (key.startsWith("record.") || key.startsWith("rank.")) return "award";
  if (key.startsWith("seasonality.")) return "calendar";
  if (key.startsWith("volume.")) return "droplet";
  if (key === "data.small_lake") return "ruler";
  return "info";
}
