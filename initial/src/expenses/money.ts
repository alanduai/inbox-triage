/**
 * Amounts as they appear in Croatian, German and English text: "1.234,56", "1,234.56", "20,00 €",
 * "$20.00", "EUR 18,47". Thousands groups must have three digits, so dates ("03.10.2026") and
 * other numbers are not read as money.
 */
export function parseAmount(text: string): number | null {
  const cleaned = text
    .replace(/[   ' ]/g, "")
    .replace(/[^\d.,-]/g, "")
    .replace(/(?!^)-/g, "");
  if (!/\d/.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const body = negative ? cleaned.slice(1) : cleaned;
  const lastComma = body.lastIndexOf(",");
  const lastDot = body.lastIndexOf(".");
  let intPart = body;
  let decPart = "";
  const decimalAt = (i: number) => {
    const after = body.slice(i + 1);
    return /^\d{1,2}$/.test(after);
  };
  if (lastComma >= 0 && lastDot >= 0) {
    // Both used: the later one is the decimal separator, the other groups thousands.
    const dec = Math.max(lastComma, lastDot);
    if (!decimalAt(dec)) return null;
    const thousands = dec === lastComma ? "." : ",";
    intPart = body.slice(0, dec);
    decPart = body.slice(dec + 1);
    if (intPart.includes(dec === lastComma ? "," : ".")) return null;
    if (!validGroups(intPart, thousands)) return null;
    intPart = intPart.split(thousands).join("");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const at = lastComma >= 0 ? lastComma : lastDot;
    const count = body.split(sep).length - 1;
    if (count === 1 && decimalAt(at)) {
      intPart = body.slice(0, at);
      decPart = body.slice(at + 1);
    } else if (validGroups(body, sep)) {
      intPart = body.split(sep).join("");
    } else return null;
  }
  if (!/^\d+$/.test(intPart) || (decPart && !/^\d{1,2}$/.test(decPart))) return null;
  const value = Number(`${intPart}.${decPart || "0"}`);
  if (!Number.isFinite(value)) return null;
  return round2(negative ? -value : value);
}

function validGroups(s: string, sep: string): boolean {
  const groups = s.split(sep);
  if (groups.length === 1) return /^\d+$/.test(s);
  return /^\d{1,3}$/.test(groups[0] ?? "") && groups.slice(1).every((g) => /^\d{3}$/.test(g));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const CURRENCY_WORDS: [RegExp, string][] = [
  [/^(€|eur|euro|eura|eur\.)$/i, "EUR"],
  [/^(\$|usd|us\$|dolar|dolara|dollar|dollars)$/i, "USD"],
  [/^(£|gbp)$/i, "GBP"],
  [/^(kn|hrk|kuna)$/i, "HRK"],
  [/^(chf|fr\.)$/i, "CHF"],
];

/** "€", "eur", "Euro" → "EUR". An unknown three-letter code is kept as it is; anything else is "". */
export function normalizeCurrency(value: string): string {
  const v = value.trim();
  if (!v) return "";
  for (const [re, code] of CURRENCY_WORDS) if (re.test(v)) return code;
  return /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : "";
}

const MONEY = /(?:€|\$|£|\b(?:EUR|USD|GBP|HRK|CHF)\b)?\s?-?\d{1,3}(?:[.,   ]\d{3})*(?:[.,]\d{1,2})?(?!\d)\s?(?:€|\$|£|\b(?:EUR|USD|GBP|HRK|CHF)\b)?/gi;

/** Every amount written in a text, for comparing a receipt with the expense it should belong to. */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MONEY)) {
    const raw = m[0];
    // A bare integer without a currency or decimals is too often a quantity, a year or an id.
    if (!/[.,]\d{1,2}(?!\d)/.test(raw) && !/[€$£]|EUR|USD|GBP|HRK|CHF/i.test(raw)) continue;
    const n = parseAmount(raw);
    if (n !== null && n !== 0) out.push(Math.abs(n));
  }
  return out;
}

export function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005 + 1e-9;
}

/** 1234.5 → "1.234,50" (Croatian). */
export function formatHr(n: number): string {
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  const grouped = (int ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n < 0 ? "-" : ""}${grouped},${dec ?? "00"}`;
}

/** 1234.5 → "1234.50" (as stored and shown on the dashboard). */
export function formatPlain(n: number): string {
  return n.toFixed(2);
}
