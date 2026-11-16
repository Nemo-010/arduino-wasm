// The one place both pages read their index configuration.
//
// The console page has a form for these; the IDE page has no settings UI of its
// own, so it reads the same keys out of localStorage. Both pages live on one
// origin, so a URL typed once on the console page is what the IDE page uses --
// a second copy of the key names would drift and leave one page pointed at the
// other's stale value.

export const CONFIG_KEYS = {
  defaultIndex: "arduino.index.default",
  extraIndexes: "arduino.index.extra",
  libraryIndex: "arduino.index.library",
  gateway: "arduino.index.gateway",
};

export function readConfig(storage = globalThis.localStorage) {
  const config = {};
  for (const [name, key] of Object.entries(CONFIG_KEYS)) {
    config[name] = storage?.getItem(key) ?? "";
  }
  return config;
}

export function extraIndexUrls(config) {
  return config.extraIndexes.split(/[\s,]+/).filter(Boolean);
}

export function settingsYaml(config) {
  const lines = [
    "directories:",
    "  data: /home/arduino/.arduino15",
    "  downloads: /home/arduino/.arduino15/staging",
    "  user: /home/arduino/Arduino",
  ];
  const extra = extraIndexUrls(config);
  if (extra.length) {
    lines.push("board_manager:", "  additional_urls:");
    for (const url of extra) lines.push(`    - ${JSON.stringify(url)}`);
  }
  lines.push("");
  return lines.join("\n");
}
