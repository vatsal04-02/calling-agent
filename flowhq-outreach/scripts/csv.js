'use strict';
// Minimal RFC 4180 CSV reader/writer for test data and reports.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((v) => v !== ''));
  const [header, ...data] = nonEmpty;
  return data.map((r, i) => {
    const o = { row_number: i + 2 };
    header.forEach((h, j) => { o[h] = r[j] === undefined ? '' : r[j]; });
    return o;
  });
}

function toCsv(rows, columns) {
  const cols = columns || Array.from(rows.reduce((set, r) => { Object.keys(r).forEach((k) => set.add(k)); return set; }, new Set()));
  const esc = (v) => {
    const t = v === undefined || v === null ? '' : String(v);
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  return [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n') + '\n';
}

module.exports = { parseCsv, toCsv };
