const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
export const formatNumber = (value) => numberFormat.format(value).replace('-', '−');

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}
