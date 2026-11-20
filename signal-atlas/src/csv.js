function nextLine(text, index) {
  return text[index] === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1;
}

// Читаем одну логическую запись, включая переносы внутри корректно закрытых кавычек.
function readRecord(text, start, delimiter, singleLineColumns) {
  const fields = [];
  let value = '',
    quoted = false,
    closed = false;
  let continuation;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    const newline = char === '\n' || char === '\r';
    if (quoted) {
      // Число или метка времени должны уместиться в одну строку замера.
      if (newline && singleLineColumns.has(fields.length)) {
        return { error: 'перенос в обязательном поле замера', next: nextLine(text, i) };
      }
      if (newline && continuation === undefined) continuation = nextLine(text, i);
      if (char !== '"') value += char;
      else if (text[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (char === delimiter) {
      fields.push(value.trim());
      value = '';
      closed = false;
    } else if (newline) {
      fields.push(value.trim());
      return { fields, next: nextLine(text, i), continuation };
    } else if (char === '"' && !closed && !value.trim()) {
      quoted = true;
      value = '';
    } else if (char === '"' || (closed && char.trim())) {
      const end = text.slice(i).search(/[\r\n]/);
      const next = continuation ?? (end < 0 ? text.length : nextLine(text, i + end));
      return { error: 'ошибка кавычек', next };
    } else value += char;
  }
  if (quoted) return { error: 'поле в кавычках не закрыто', next: continuation ?? text.length };
  fields.push(value.trim());
  return { fields, next: text.length, continuation };
}

export function parseCsv(source, required, filename, { recoverRows = false } = {}) {
  const text = source.replace(/^\uFEFF/, '');
  const firstLine = text.trimStart().split(/[\r\n]/, 1)[0];
  const delimiter = [',', ';', '\t'].sort(
    (a, b) => firstLine.split(b).length - firstLine.split(a).length,
  )[0];
  let columns;
  const singleLineColumns = new Set();
  const rows = [];
  for (let index = 0; index < text.length; ) {
    const record = readRecord(text, index, delimiter, singleLineColumns);
    index = record.next;
    if (record.error) {
      if (!columns || !recoverRows)
        throw new Error(
          filename + ' — ' + record.error + ' в записи ' + (rows.length + (columns ? 2 : 1)) + '.',
        );
      rows.push(null);
      continue;
    }
    const { fields } = record;
    if (fields.length === 1 && fields[0] === '') continue;
    if (!columns) {
      columns = fields.map((name) => name.toLowerCase());
      if (new Set(columns).size !== columns.length)
        throw new Error(filename + ' — заголовки повторяются.');
      const missing = required.filter((name) => !columns.includes(name));
      if (missing.length) throw new Error(filename + ' — отсутствуют поля ' + missing.join(', '));
      if (recoverRows) {
        for (const name of required) singleLineColumns.add(columns.indexOf(name));
      }
      continue;
    }
    if (fields.length !== columns.length) {
      rows.push(null);
      if (recoverRows && record.continuation !== undefined) index = record.continuation;
      continue;
    }
    rows.push(Object.fromEntries(columns.map((name, i) => [name, fields[i]])));
  }
  if (!columns) throw new Error(filename + ' — отсутствуют поля ' + required.join(', '));
  return rows;
}
