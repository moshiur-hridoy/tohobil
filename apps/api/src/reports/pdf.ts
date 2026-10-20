import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

const require = createRequire(import.meta.url);
const fontFile = (script: 'bengali' | 'latin', weight: 400 | 700) =>
  require.resolve(`@fontsource/noto-sans-bengali/files/noto-sans-bengali-${script}-${weight}-normal.woff`);

/** The font package ships Bengali and Latin as separate files; text is split into runs, each drawn with its own font. */
const BENGALI = /[।॥ঀ-৿‌‍]/;

const PAGE = { width: 595.28, height: 841.89 }; // A4
const MARGIN = 48;
const LINE = 16;
const GREY = '#737373';
const RULE = '#cccccc';

export interface Column {
  header: string;
  /** Share of the table width; the widths of all columns should add up to 1. */
  width: number;
  align?: 'left' | 'right';
}

/**
 * A small page-flow writer for the statements and the annual summary. PDFKit applies the font's own
 * shaping and mark positioning, so Bengali conjuncts (শ্রদ্ধা, সন্ধ্যা) come out right. Text never
 * runs off the page: long cells wrap and tables continue on a new page.
 *
 * Coordinates are measured down from the top of the page.
 */
export class PdfWriter {
  private readonly doc: PDFKit.PDFDocument;
  private readonly chunks: Buffer[] = [];
  private y = MARGIN;
  private pageNo = 1;

  constructor(title: string, private readonly footer: string) {
    // Margins are zero on purpose: this class decides when to break the page, PDFKit must never do it.
    this.doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: title, Creator: 'Barakah Fund' } });
    this.doc.on('data', (c: Buffer) => this.chunks.push(c));
    for (const script of ['bengali', 'latin'] as const) {
      this.doc.registerFont(`${script}-regular`, fontFile(script, 400));
      this.doc.registerFont(`${script}-bold`, fontFile(script, 700));
    }
    this.drawFooter();
  }

  private drawFooter(): void {
    this.draw(`${this.footer} · ${this.pageNo}`, MARGIN, PAGE.height - 34, 8, false, GREY);
  }

  private newPage(): void {
    this.doc.addPage({ size: 'A4', margin: 0 });
    this.pageNo += 1;
    this.y = MARGIN;
    this.drawFooter();
  }

  private ensure(height: number): void {
    if (this.y + height > PAGE.height - MARGIN - 8) this.newPage();
  }

  private runs(text: string, bold: boolean): Array<{ text: string; font: string }> {
    const weight = bold ? 'bold' : 'regular';
    const out: Array<{ text: string; font: string }> = [];
    for (const ch of text) {
      const font = `${BENGALI.test(ch) ? 'bengali' : 'latin'}-${weight}`;
      const last = out[out.length - 1];
      if (last && last.font === font) last.text += ch;
      else out.push({ text: ch, font });
    }
    return out;
  }

  private width(text: string, size: number, bold: boolean): number {
    return this.runs(text, bold).reduce((sum, r) => sum + this.doc.font(r.font).fontSize(size).widthOfString(r.text), 0);
  }

  private draw(text: string, x: number, y: number, size: number, bold: boolean, color = '#000000'): void {
    let cursor = x;
    for (const r of this.runs(text, bold)) {
      this.doc.font(r.font).fontSize(size).fillColor(color);
      this.doc.text(r.text, cursor, y, { lineBreak: false });
      cursor += this.doc.widthOfString(r.text);
    }
  }

  private wrap(text: string, bold: boolean, size: number, maxWidth: number): string[] {
    const out: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (this.width(next, size, bold) <= maxWidth || !line) line = next;
        else {
          out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out;
  }

  heading(text: string, size = 16): void {
    this.ensure(size + 12);
    this.draw(text, MARGIN, this.y, size, true);
    this.y += size + 10;
  }

  paragraph(text: string, size = 10): void {
    for (const line of this.wrap(text, false, size, PAGE.width - 2 * MARGIN)) {
      this.ensure(LINE);
      this.draw(line, MARGIN, this.y, size, false);
      this.y += LINE;
    }
    this.y += 4;
  }

  /** `label ......... value` on one line. */
  keyValue(label: string, value: string): void {
    this.ensure(LINE);
    const size = 10;
    this.draw(label, MARGIN, this.y, size, false);
    this.draw(value, PAGE.width - MARGIN - this.width(value, size, true), this.y, size, true);
    this.y += LINE;
  }

  space(points = 8): void {
    this.y += points;
  }

  table(columns: Column[], rows: string[][]): void {
    const total = PAGE.width - 2 * MARGIN;
    const xs: number[] = [];
    let x = MARGIN;
    for (const c of columns) {
      xs.push(x);
      x += c.width * total;
    }
    const size = 9;
    const drawRow = (cells: string[], bold: boolean): void => {
      const wrapped = cells.map((cell, i) => this.wrap(cell, bold, size, columns[i]!.width * total - 6));
      const height = Math.max(...wrapped.map((w) => w.length)) * 13 + 5;
      this.ensure(height);
      wrapped.forEach((lines, i) => {
        const col = columns[i]!;
        lines.forEach((line, n) => {
          const w = this.width(line, size, bold);
          const cellX = col.align === 'right' ? xs[i]! + col.width * total - 6 - w : xs[i]!;
          this.draw(line, cellX, this.y + n * 13, size, bold);
        });
      });
      this.y += height;
      this.doc.moveTo(MARGIN, this.y - 2).lineTo(PAGE.width - MARGIN, this.y - 2).lineWidth(0.4).strokeColor(RULE).stroke();
    };
    drawRow(columns.map((c) => c.header), true);
    for (const row of rows) drawRow(row, false);
    this.y += 6;
  }

  finish(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)));
      this.doc.on('error', reject);
      this.doc.end();
    });
  }
}
