// The three numbers printed on the card, as digits only (expiry as MMYY).
export type Field = "card" | "expiry" | "activation";
export type Numbers = Record<Field, string>;
export const FIELDS: Field[] = ["card", "expiry", "activation"];
export const EMPTY: Numbers = { card: "", expiry: "", activation: "" };

export const LENGTH: Record<Field, number> = { card: 16, expiry: 4, activation: 12 };

// Only the card number carries a check digit (luhn), so a value counts only once
// this many frames read it the same; one misread digit then needs the same misread twice.
export const VOTES_NEEDED = 2;

// What one frame read (readFrame in public/reader-core.js), expiry as MM/YY.
export type Read = Partial<Record<Field, { value: string } | null>>;
export type Votes = Record<Field, Record<string, number>>;
export const NO_VOTES: Votes = { card: {}, expiry: {}, activation: {} };

export function vote(votes: Votes, read: Read): Votes {
  const next: Votes = { card: { ...votes.card }, expiry: { ...votes.expiry }, activation: { ...votes.activation } };
  for (const field of FIELDS) {
    const value = read[field]?.value.replace("/", "");
    if (value) next[field][value] = (next[field][value] ?? 0) + 1;
  }
  return next;
}

// Each field's value once it has enough votes; null while any field has none.
export function settled(votes: Votes): Numbers | null {
  const out = { ...EMPTY };
  for (const field of FIELDS) {
    const top = Object.entries(votes[field]).find(([, n]) => n >= VOTES_NEEDED);
    if (!top) return null;
    out[field] = top[0];
  }
  return out;
}

export function digitsOnly(text: string, field: Field): string {
  return text.replace(/\D/g, "").slice(0, LENGTH[field]);
}

// Shown in groups of four, the expiry as MM/YY.
export function display(value: string, field: Field): string {
  if (field === "expiry") return value.length > 2 ? `${value.slice(0, 2)}/${value.slice(2)}` : value;
  return value.replace(/(\d{4})(?=\d)/g, "$1 ");
}

// Card numbers end in a Luhn check digit (payment card numbering), as luhn in
// public/reader-core.js checks reads.
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

export function problem(value: string, field: Field): string | null {
  if (value.length !== LENGTH[field]) {
    return field === "expiry" ? "월 2자리와 연도 2자리를 입력해 주세요" : `숫자 ${LENGTH[field]}자리를 입력해 주세요`;
  }
  if (field === "card" && !luhn(value)) return "카드번호가 맞지 않습니다. 다시 확인해 주세요";
  if (field === "expiry") {
    const month = Number(value.slice(0, 2));
    if (month < 1 || month > 12) return "월은 01부터 12까지입니다";
  }
  return null;
}
