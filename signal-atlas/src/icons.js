const paths = {
  brand:
    '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M7.7 7.8a6 6 0 0 0 0 8.4m8.6-8.4a6 6 0 0 1 0 8.4M4.4 4.7a10.5 10.5 0 0 0 0 14.6m15.2-14.6a10.5 10.5 0 0 1 0 14.6"/>',
  map: '<path d="m3 5 6-2 6 3 6-2v15l-6 2-6-3-6 2zM9 3v15m6-12v15"/>',
  chart: '<path d="M4 3v17h17M9 15v-4m5 4V6m5 9V9"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v13c0 4 16 4 16 0V5M4 11c0 4 16 4 16 0"/>',
  pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.3"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v4c0 1 .8 2 2 2h12a2 2 0 0 0 2-2v-4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  signal: '<path d="M3 19v-3m5 3v-7m5 7V8m5 11V4" stroke-width="2.8"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="7" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/><rect x="14" y="14" width="7" height="7" rx="1.3"/>',
  weak: '<path d="M3 18v-3m5 3v-7m5 7V7" stroke-width="2.6"/><path d="m17 5 4 4m0-4-4 4"/>',
  target:
    '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  heat: '<path d="M13 2c0 4-4 5-4 9-2-1-2-3-2-3-6 7-2 13 5 13 7 0 11-8 5-15 0 4-2 5-2 5s2-5-2-9Z"/>',
  layers: '<path d="m3 8 9-5 9 5-9 5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  tower:
    '<path d="m8 21 4-11 4 11m-7-3h6M7 5a7 7 0 0 0 0 9m10-9a7 7 0 0 1 0 9M4 2a11 11 0 0 0 0 15M20 2a11 11 0 0 1 0 15"/><circle cx="12" cy="9" r="1.2" fill="currentColor"/>',
  aim: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  plus: '<path d="M5 12h14m-7-7v14"/>',
  minus: '<path d="M5 12h14"/>',
  focus: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.5 14.5a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z"/>',
  list: '<path d="M9 5h12M9 12h12M9 19h12"/><circle cx="4" cy="5" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="19" r="1"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.2"/>',
  file: '<path d="M5 2h9l5 5v15H5zM14 2v6h5M8 13h8m-8 4h6"/>',
  compare:
    '<path d="M4 6h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="18" r="2" fill="currentColor"/>',
};
export function icon(name, size = 18) {
  return (
    '<svg class="icon" aria-hidden="true" width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    paths[name] +
    '</svg>'
  );
}
