import ExcelJS from 'exceljs';
import { parseSheetTimecodeToSeconds } from './sheetTimecode';

export interface ParsedLogRow {
  sheetSec: number;
  message: string;
  type: string;
  rawTimecode: string;
}

export interface ParsedSheet {
  name: string;
  rows: ParsedLogRow[];
}

const SHEET_ID_RE = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;

export function extractSpreadsheetId(url: string): string | null {
  const m = SHEET_ID_RE.exec(url);
  return m ? m[1] : null;
}

export function xlsxExportUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx`;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
    return value.text;
  }
  if (typeof value === 'object' && 'richText' in value && Array.isArray(value.richText)) {
    return value.richText.map((t: { text?: string }) => t.text ?? '').join('');
  }
  return String(value);
}

export async function parseWorkbookBuffer(
  buf: ArrayBuffer | Uint8Array | Buffer,
): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(new Uint8Array(buf));
  await wb.xlsx.load(nodeBuf as never);
  const sheets: ParsedSheet[] = [];
  for (const ws of wb.worksheets) {
    const rows: ParsedLogRow[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber < 7) return;
      const a = cellText(row.getCell(1).value).trim();
      if (!a) return;
      const sheetSec = parseSheetTimecodeToSeconds(a);
      if (sheetSec === null) return;
      const message = cellText(row.getCell(2).value);
      const type = cellText(row.getCell(3).value);
      rows.push({ sheetSec, message, type, rawTimecode: a });
    });
    sheets.push({ name: ws.name, rows });
  }
  return sheets;
}

export async function fetchPublicWorkbookSheets(
  spreadsheetUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ParsedSheet[]> {
  const id = extractSpreadsheetId(spreadsheetUrl);
  if (!id) throw new Error('Could not parse Google Sheets spreadsheet id from URL.');

  const urls = [
    xlsxExportUrl(id),
    // Some share links resolve more reliably with the uc export endpoint.
    `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx&id=${id}`,
  ];

  let lastErr: Error | null = null;
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, {
        redirect: 'follow',
        headers: {
          // Google sometimes serves a soft block / HTML interstitial to bare clients.
          'User-Agent': 'AutologgerLogImport/1.0 (compatible; +https://localhost)',
          Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*',
        },
      });
      if (!res.ok) {
        lastErr = new Error(
          `Could not download spreadsheet (HTTP ${res.status} ${res.statusText || ''}). Ensure it is shared as anyone-with-the-link can view.`.trim(),
        );
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const head = buf.subarray(0, 64).toString('utf8');
      if (head.includes('<!DOCTYPE') || head.includes('<html') || head.includes('<HTML')) {
        lastErr = new Error(
          'Spreadsheet download returned HTML instead of XLSX. Ensure the sheet is shared as anyone-with-the-link can view.',
        );
        continue;
      }
      // XLSX is a zip — PK magic
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        lastErr = new Error(
          'Spreadsheet download was not a valid XLSX file. Ensure the sheet is shared as anyone-with-the-link can view.',
        );
        continue;
      }
      return parseWorkbookBuffer(buf);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error('Could not download spreadsheet.');
}
