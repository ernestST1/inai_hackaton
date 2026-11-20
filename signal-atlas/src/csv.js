// Read quoted fields, including embedded delimiters, quotes and newlines.
export function parseCsv(source, required, filename) {
  const text = source.replace(/^\uFEFF/, '');
  const header = text.split(/[\r\n]/, 1)[0];
  const delimiter = [',', ';', '\t'].sort((a, b) => header.split(b).length - header.split(a).length)[0];
  const records = [];
  let record = [], value = '', quoted = false, closed = false;
  function finishRecord() {
    record.push(value.trim());
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
    value = '';
    closed = false;
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') value += char;
      else if (text[i + 1] === '"') { value += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (char === delimiter) {
      record.push(value.trim());
      value = '';
      closed = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      finishRecord();
    } else if (char === '"' && !value && !closed) {
      quoted = true;
    } else if (char === '"' || (closed && char.trim())) {
      throw new Error(filename + ' — ошибка кавычек в записи ' + (records.length + 1));
    } else value += char;
  }
  if (quoted) throw new Error(filename + ' — поле в кавычках не закрыто.');
  finishRecord();
  const columns = (records.shift() || []).map(name => name.toLowerCase());
  if (new Set(columns).size !== columns.length) throw new Error(filename + ' — заголовки повторяются.');
  const missing = required.filter(name => !columns.includes(name));
  if (missing.length) throw new Error(filename + ' — отсутствуют поля ' + missing.join(', '));
  return records.map(fields => fields.length === columns.length
    ? Object.fromEntries(columns.map((column, i) => [column, fields[i]]))
    : null);
}
