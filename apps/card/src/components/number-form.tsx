"use client";

import { useState } from "react";
import { digitsOnly, display, FIELDS, problem, type Field, type Numbers } from "@/lib/fields";

const LABEL: Record<Field, string> = {
  card: "카드번호 (16자리)",
  expiry: "만료일 (MM/YY)",
  activation: "활성화 번호 (12자리)",
};

export default function NumberForm({ title, note, initial, onRetake }: {
  title: string;
  note: string;
  initial: Numbers;
  onRetake: () => void;
}) {
  const [values, setValues] = useState(initial);
  // A field's problem shows once it has been left, not while it is typed.
  const [left, setLeft] = useState<Record<Field, boolean>>({ card: false, expiry: false, activation: false });

  return (
    <section className="numbers">
      <h1>{title}</h1>
      <p>{note}</p>
      {FIELDS.map((field) => {
        const issue = left[field] ? problem(values[field], field) : null;
        return (
          <label key={field} className="field">
            <span>{LABEL[field]}</span>
            <input
              inputMode="numeric"
              autoComplete="off"
              value={display(values[field], field)}
              aria-invalid={issue != null}
              aria-describedby={issue ? `${field}-problem` : undefined}
              onChange={(event) => setValues({ ...values, [field]: digitsOnly(event.target.value, field) })}
              onBlur={() => setLeft({ ...left, [field]: true })}
            />
            {issue && <em id={`${field}-problem`}>{issue}</em>}
          </label>
        );
      })}
      <div className="actions">
        <button type="button" onClick={onRetake}>
          다시 찍기
        </button>
      </div>
    </section>
  );
}
