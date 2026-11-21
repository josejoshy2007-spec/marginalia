/**
 * Student-written recall cards:  npx tsx scripts/cards-test.mts
 * add / edit / delete round-trip, SRS kept on edit, tombstone on delete, no-citation cards load.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";

const { db } = await import("../lib/local/db");
const { localApi } = await import("../lib/local/store");

let passed = 0;
const ok = (l: string) => (passed++, console.log(`✓ ${l}`));

const subject = await localApi.createSubject("Maths");
const deckId = await db.artifacts.add({
  subject_id: subject.id, kind: "deck", subtype: "", title: "Deck", params: {}, content: {}, passages: [],
  status: "ready", error: null, created_at: new Date().toISOString(),
} as any);

// Add: new, due now, no citation.
const added = await localApi.addCard(deckId, { front: "  Derivative of $x^2$?  ", back: "$2x$" });
assert.equal(added.front, "Derivative of $x^2$?");
assert.deepEqual(added.cite, []);
assert.equal(added.is_new, true);
const row = (await db.cards.get(added.id))!;
assert.ok(row.uid && row.updated_at, "hooks stamp uid and updated_at");
assert.equal(row.reps, 0);
assert.ok(row.due_at <= new Date().toISOString());
const q1 = await localApi.reviewQueue(deckId);
assert.deepEqual(q1.cards.map((c) => c.id), [added.id]);
ok("addCard: trimmed, new, due now, uid + updated_at stamped, appears in the review queue");

// A manual card (no citation) loads in the deck detail and the summary counts.
const detail = await localApi.artifact(deckId);
assert.equal(detail.cards?.length, 1);
assert.deepEqual(detail.cards![0].cite, []);
const [summary] = (await localApi.artifacts(subject.id, "deck")) as any[];
assert.equal(summary.card_count, 1);
assert.equal(summary.due_count, 1);
ok("a card without a citation loads in the deck, and counts update");

// Empty text is refused.
await assert.rejects(() => localApi.addCard(deckId, { front: " ", back: "x" }), /front and a back/);
await assert.rejects(() => localApi.addCard(deckId, { front: "x", back: "" }), /front and a back/);
await assert.rejects(() => localApi.updateCard(added.id, { front: "", back: "x" }), /front and a back/);
assert.equal((await db.cards.where("deck_id").equals(deckId).count()), 1);
ok("empty fronts and backs are rejected");

// Edit keeps the schedule.
const graded = await localApi.gradeCard(added.id, "good");
const before = (await db.cards.get(added.id))!;
await new Promise((r) => setTimeout(r, 5));
const edited = await localApi.updateCard(added.id, { front: "d/dx of $x^3$?", back: "$3x^2$" });
const after = (await db.cards.get(added.id))!;
assert.equal(edited.front, "d/dx of $x^3$?");
assert.equal(after.back, "$3x^2$");
for (const k of ["ease", "interval_days", "reps", "lapses", "due_at", "last_reviewed_at", "uid", "deck_id"] as const)
  assert.deepEqual(after[k], before[k], k);
assert.ok((after.updated_at ?? "") > (before.updated_at ?? ""), "edit stamps updated_at");
assert.equal(edited.is_new, false);
assert.equal(graded.reps, 1);
ok("updateCard changes the text only: SRS state and uid kept, updated_at newer");

// Delete writes a tombstone and removes the card from the queue.
const second = await localApi.addCard(deckId, { front: "Q2", back: "A2" });
const uid = (await db.cards.get(second.id))!.uid!;
await localApi.deleteCard(second.id);
assert.equal(await db.cards.get(second.id), undefined);
const tomb = await db.tombstones.get(uid);
assert.equal(tomb?.table, "cards");
assert.ok((await localApi.reviewQueue(deckId)).cards.every((c) => c.id !== second.id));
await localApi.deleteCard(second.id); // deleting twice is harmless
ok("deleteCard: row gone, tombstone written, leaves the review queue");

console.log(`\nALL ${passed} CARD CHECKS PASSED`);
