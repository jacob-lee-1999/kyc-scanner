import assert from "node:assert/strict";
import test from "node:test";
import { digitsOnly, display, NO_VOTES, problem, settled, vote } from "../src/lib/fields.ts";

const read = (card: string | null, expiry: string | null, activation: string | null) => ({
  card: card ? { value: card } : null,
  expiry: expiry ? { value: expiry } : null,
  activation: activation ? { value: activation } : null,
});

test("a value is settled once two frames read it the same", () => {
  let votes = vote(NO_VOTES, read("1111222233334444", "08/29", "123412341234"));
  assert.equal(settled(votes), null);
  votes = vote(votes, read("1111222233334444", "08/29", "123412341234"));
  assert.deepEqual(settled(votes), { card: "1111222233334444", expiry: "0829", activation: "123412341234" });
});

test("disagreeing reads wait for a repeat, and a missing field holds back the rest", () => {
  let votes = vote(NO_VOTES, read("1111222233334444", "08/29", null));
  votes = vote(votes, read("1111222233334449", "08/29", "123412341234"));
  assert.equal(settled(votes), null);
  votes = vote(votes, read("1111222233334449", null, "123412341234"));
  assert.deepEqual(settled(votes), { card: "1111222233334449", expiry: "0829", activation: "123412341234" });
});

test("vote leaves the votes it was given alone", () => {
  vote(NO_VOTES, read("1111222233334444", "08/29", "123412341234"));
  assert.deepEqual(NO_VOTES, { card: {}, expiry: {}, activation: {} });
});

test("input keeps digits up to the field length", () => {
  assert.equal(digitsOnly("1234 5678-9012 34567", "card"), "1234567890123456");
  assert.equal(digitsOnly("08/29", "expiry"), "0829");
});

test("numbers show in groups of four and the expiry as MM/YY", () => {
  assert.equal(display("1234567890123456", "card"), "1234 5678 9012 3456");
  assert.equal(display("123456789012", "activation"), "1234 5678 9012");
  assert.equal(display("12345", "card"), "1234 5");
  assert.equal(display("0829", "expiry"), "08/29");
  assert.equal(display("08", "expiry"), "08");
});

test("format check: length, month and the card check digit", () => {
  assert.equal(problem("1234567890123452", "card"), null);
  assert.match(problem("1234567890123456", "card")!, /다시 확인/);
  assert.match(problem("123456789012345", "card")!, /16자리/);
  assert.match(problem("12345678901", "activation")!, /12자리/);
  assert.equal(problem("1229", "expiry"), null);
  assert.match(problem("1329", "expiry")!, /월/);
  assert.match(problem("0029", "expiry")!, /월/);
  assert.match(problem("082", "expiry")!, /연도/);
});
