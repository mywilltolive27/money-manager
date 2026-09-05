// export-xlsx.js — export transactions for a month or range to .xlsx / .xls (SheetJS)
(function () {
  const $ = (s) => document.querySelector(s);

  function monthsBetween(from, to) {
    const out = [];
    let [y, m] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      out.push(y + '-' + String(m).padStart(2, '0'));
      if (++m > 12) { m = 1; y++; }
      if (out.length > 600) break; // safety
    }
    return out;
  }

  // Apply a thousands number format to the named columns of a json_to_sheet sheet.
  function formatCols(ws, numHeaders) {
    const range = XLSX.utils.decode_range(ws['!ref']);
    const cols = {};
    for (let c = range.s.c; c <= range.e.c; c++) {
      const h = ws[XLSX.utils.encode_cell({ r: 0, c })];
      if (h && numHeaders.indexOf(h.v) !== -1) cols[c] = true;
    }
    for (let r = 1; r <= range.e.r; r++) {
      for (const c in cols) {
        const cell = ws[XLSX.utils.encode_cell({ r, c: Number(c) })];
        if (cell && typeof cell.v === 'number') cell.z = '#,##0';
      }
    }
  }

  function build(fromM, toM) {
    if (fromM > toM) { const t = fromM; fromM = toM; toM = t; }
    const data = window.LedgerCore.data;
    const months = monthsBetween(fromM, toM);
    const txs = data.transactions
      .filter((t) => { const k = t.date.slice(0, 7); return k >= fromM && k <= toM; })
      .sort((a, b) => a.date.localeCompare(b.date));

    const txRows = txs.map((t) => ({
      Month: t.date.slice(0, 7),
      Date: t.date,
      Description: t.description || '',
      Category: t.category,
      Type: t.type === 'income' ? 'Income' : 'Expense',
      Amount: Number(t.amount),
    }));

    const summaryRows = months.map((k) => {
      const mt = txs.filter((t) => t.date.slice(0, 7) === k);
      const income = mt.filter((t) => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0);
      const expenses = mt.filter((t) => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);
      return {
        Month: k,
        Income: income,
        Expenses: expenses,
        Surplus: income - expenses,
        Budget: Number((data.budgets && data.budgets[k]) || 0),
      };
    });
    if (months.length > 1) {
      const tot = summaryRows.reduce(
        (a, r) => ({
          Income: a.Income + r.Income,
          Expenses: a.Expenses + r.Expenses,
          Surplus: a.Surplus + r.Surplus,
          Budget: a.Budget + r.Budget,
        }),
        { Income: 0, Expenses: 0, Surplus: 0, Budget: 0 }
      );
      summaryRows.push({ Month: 'TOTAL', ...tot });
    }

    const cats = Array.from(new Set(txs.map((t) => t.category))).sort();
    const categoryRows = cats.map((c) => {
      const row = { Category: c };
      let total = 0;
      months.forEach((k) => {
        const v = txs
          .filter((t) => t.category === c && t.date.slice(0, 7) === k)
          .reduce((s, t) => s + Number(t.amount), 0);
        row[k] = v;
        total += v;
      });
      row.Total = total;
      return row;
    });

    const wb = XLSX.utils.book_new();

    const wsTx = XLSX.utils.json_to_sheet(txRows);
    wsTx['!cols'] = [{ wch: 9 }, { wch: 12 }, { wch: 28 }, { wch: 18 }, { wch: 9 }, { wch: 12 }];
    formatCols(wsTx, ['Amount']);
    XLSX.utils.book_append_sheet(wb, wsTx, 'Transactions');

    const wsSum = XLSX.utils.json_to_sheet(summaryRows);
    wsSum['!cols'] = [{ wch: 9 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    formatCols(wsSum, ['Income', 'Expenses', 'Surplus', 'Budget']);
    XLSX.utils.book_append_sheet(wb, wsSum, 'Monthly Summary');

    if (categoryRows.length) {
      const wsCat = XLSX.utils.json_to_sheet(categoryRows);
      wsCat['!cols'] = [{ wch: 18 }].concat(months.map(() => ({ wch: 11 })), [{ wch: 12 }]);
      formatCols(wsCat, months.concat(['Total']));
      XLSX.utils.book_append_sheet(wb, wsCat, 'By Category');
    }

    return { wb, months, count: txs.length };
  }

  function doDownload() {
    if (!window.XLSX) { alert('Excel library not loaded yet — check your connection and retry.'); return; }
    const from = $('#xlsxFrom').value;
    const to = $('#xlsxTo').value;
    if (!from || !to) { alert('Pick both a "from" and "to" month.'); return; }
    const fmt = $('#xlsxFormat').value === 'xls' ? 'xls' : 'xlsx';

    const { wb, months, count } = build(from, to);
    if (count === 0 && !confirm('No transactions in that range. Export an empty workbook anyway?')) return;

    const base =
      months.length === 1
        ? 'akeera_' + months[0]
        : 'akeera_' + months[0] + '_to_' + months[months.length - 1];
    XLSX.writeFile(wb, base + '.' + fmt, { bookType: fmt === 'xls' ? 'biff8' : 'xlsx' });
    $('#xlsxOverlay').classList.remove('open');
  }

  function openModal() {
    const cur = (window.LedgerCore && window.LedgerCore.viewMonth) ||
      new Date().toISOString().slice(0, 7);
    $('#xlsxFrom').value = cur;
    $('#xlsxTo').value = cur;
    $('#xlsxOverlay').classList.add('open');
  }

  function wire() {
    const btn = $('#exportXlsxBtn');
    if (!btn) return;
    btn.onclick = openModal;
    $('#xlsxCancel').onclick = () => $('#xlsxOverlay').classList.remove('open');
    $('#xlsxDownload').onclick = doDownload;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
