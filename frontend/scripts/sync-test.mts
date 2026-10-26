/**
 * Drive-sync scenario test: two simulated devices (separate processes, separate databases) syncing
 * through a fake Drive folder. No network or Google account needed.
 *   npx tsx scripts/sync-test.mts
 */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const driveDir = mkdtempSync(path.join(tmpdir(), "marginalia-drive-"));
const script = path.join(import.meta.dirname, "sync-device.mts");

function device(name: string) {
  const child: ChildProcess = fork(script, [driveDir], { execArgv: ["--import", "tsx"], stdio: ["inherit", "inherit", "inherit", "ipc"] });
  let next = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const ready = new Promise<void>((r) => child.once("message", () => r()));
  child.on("message", (m: any) => {
    if (m.ready) return;
    const p = pending.get(m.id)!;
    pending.delete(m.id);
    m.ok ? p.resolve(m.value) : p.reject(new Error(`[${name}] ${m.error}`));
  });
  const run = async (cmd: string, args?: object) => {
    await ready;
    const id = next++;
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.send({ id, cmd, args });
    });
  };
  return { run, stop: () => child.kill() };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const A = device("A");
const B = device("B");
let passed = 0;
const check = (label: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`✓ ${label}`);
};

try {
  // 1. Device A builds a library and syncs it up.
  await A.run("subject", { name: "Biology" });
  await A.run("source", { subject: "Biology", title: "Notes" });
  await A.run("deck", { subject: "Biology", source: "Notes", title: "Cells deck" });
  await A.run("sync");
  const files = readdirSync(driveDir);
  check("Drive has the library and one source file", () => {
    assert.ok(files.includes("library.json.gz"));
    assert.equal(files.filter((f) => f.startsWith("source-")).length, 1);
  });

  // 2. A fresh device B pulls everything, with citations and params remapped to its own ids.
  const r = await B.run("sync");
  const b1 = await B.run("state");
  check("B received subject, indexed source, deck, cards, attempt", () => {
    assert.deepEqual(b1.Biology.sources, [{ title: "Notes", status: "ready", chunks: 3, textOk: true }]);
    assert.deepEqual(b1.Biology.decks[0].cards, ["Q1:reps0", "Q2:reps0"]);
    assert.equal(b1.Biology.decks[0].attempts, 1);
    assert.ok(r.added >= 6);
  });
  check("B's citation points at the right chunk of its own copy", () => {
    assert.equal(b1.Biology.decks[0].citation, "Gamma paragraph.");
    assert.ok(b1.Biology.decks[0].paramsOk);
  });

  // 3. Edits on both devices merge.
  await B.run("grade", { deck: "Cells deck", front: "Q1", grade: "good" });
  await A.run("subject", { name: "Physics" });
  await A.run("sync");
  await B.run("sync");
  await A.run("sync");
  const [a3, b3] = [await A.run("state"), await B.run("state")];
  check("edits from both devices reach both", () => {
    assert.deepEqual(Object.keys(b3).sort(), ["Biology", "Physics"]);
    assert.deepEqual(a3.Biology.decks[0].cards, ["Q1:reps1", "Q2:reps0"]);
    assert.deepEqual(a3, b3);
  });

  // 4. Conflicting edits: the later one wins everywhere.
  await A.run("rename", { from: "Physics", to: "Physics HL (A)" });
  await wait(20);
  await B.run("rename", { from: "Physics", to: "Physics HL" });
  await A.run("sync");
  await B.run("sync");
  await A.run("sync");
  const [a4, b4] = [await A.run("state"), await B.run("state")];
  check("later rename wins on both devices", () => {
    assert.deepEqual(Object.keys(a4).sort(), ["Biology", "Physics HL"]);
    assert.deepEqual(a4, b4);
  });

  // 5. Offline overlap: both sync from the same starting point; nothing is lost.
  await A.run("source", { subject: "Physics HL", title: "Waves" });
  await B.run("source", { subject: "Physics HL", title: "Optics" });
  await A.run("sync");
  await B.run("sync");
  await A.run("sync");
  const [a5, b5] = [await A.run("state"), await B.run("state")];
  check("sources added on both devices both survive", () => {
    assert.deepEqual(a5["Physics HL"].sources.map((s: any) => s.title).sort(), ["Optics", "Waves"]);
    assert.deepEqual(a5, b5);
  });

  // 6. Deleting a deck on B removes it (and its cards/attempts) on A.
  await B.run("deleteDeck", { title: "Cells deck" });
  await B.run("sync");
  await A.run("sync");
  const a6 = await A.run("state");
  check("deleted deck disappears on the other device", () => assert.deepEqual(a6.Biology.decks, []));

  // 7. Deleting a whole subject removes its sources and their Drive files everywhere.
  const before = readdirSync(driveDir).filter((f) => f.startsWith("source-")).length;
  await A.run("deleteSubject", { name: "Physics HL" });
  await A.run("sync");
  await B.run("sync");
  const [a7, b7] = [await A.run("state"), await B.run("state")];
  check("deleted subject disappears everywhere, its source files leave Drive", () => {
    assert.deepEqual(Object.keys(b7), ["Biology"]);
    assert.deepEqual(a7, b7);
    assert.equal(readdirSync(driveDir).filter((f) => f.startsWith("source-")).length, before - 2);
  });

  // 8. A deleted item stays deleted even if the other device edits it before syncing.
  await A.run("subject", { name: "Economics" });
  await A.run("sync");
  await B.run("sync");
  await A.run("deleteSubject", { name: "Economics" });
  await wait(20);
  await B.run("rename", { from: "Economics", to: "Economics SL" });
  await A.run("sync");
  await B.run("sync");
  await A.run("sync");
  const [a8, b8] = [await A.run("state"), await B.run("state")];
  check("deletion wins over a later edit; devices agree", () => {
    assert.deepEqual(Object.keys(a8), ["Biology"]);
    assert.deepEqual(a8, b8);
  });

  // 9. Conversations are kept per subject: making and switching subjects never loses them.
  await A.run("subject", { name: "Chemistry" });
  await A.run("source", { subject: "Chemistry", title: "Bonding" });
  await A.run("conversation", { subject: "Chemistry", title: "Ionic vs covalent", source: "Bonding" });
  await A.run("conversation", { subject: "Chemistry", title: "Exam tips", mode: "general" });
  await A.run("subject", { name: "History" });
  await A.run("conversation", { subject: "History", title: "Causes of WW1", mode: "general" });
  const [chem, hist] = [await A.run("conversations", { subject: "Chemistry" }), await A.run("conversations", { subject: "History" })];
  check("each subject keeps its own saved conversations after making another subject", () => {
    assert.deepEqual(chem, ["Exam tips:general:2", "Ionic vs covalent:sources:2"]);
    assert.deepEqual(hist, ["Causes of WW1:general:2"]);
  });

  // 10. Conversations sync, with citations remapped to the other device's copy of the source.
  await A.run("sync");
  await B.run("sync");
  const [a10, b10] = [await A.run("state"), await B.run("state")];
  check("conversations reach the other device with working citations", () => {
    assert.deepEqual(b10.Chemistry.conversations, [
      { title: "Exam tips", mode: "general", turns: 2, citation: null },
      { title: "Ionic vs covalent", mode: "sources", turns: 2, citation: "Gamma paragraph." },
    ]);
    assert.deepEqual(a10, b10);
  });

  // 11. Deleting a conversation on one device removes it on the other.
  await B.run("deleteConversation", { title: "Exam tips" });
  await B.run("sync");
  await A.run("sync");
  const a11 = await A.run("conversations", { subject: "Chemistry" });
  check("deleted conversation disappears on the other device", () => assert.deepEqual(a11, ["Ionic vs covalent:sources:2"]));

  console.log(`\nALL ${passed} SYNC CHECKS PASSED`);
} finally {
  A.stop();
  B.stop();
  if (existsSync(driveDir)) rmSync(driveDir, { recursive: true, force: true });
}
