/**
 * Drive-sync scenario test: two simulated devices (separate processes, separate databases) syncing
 * through a fake Drive folder. No network or Google account needed.
 *   npx tsx scripts/sync-test.mts
 */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

  // 5b. Student-written cards: an edit and an added card (A) and a deleted card (B) reach both devices.
  await A.run("editCard", { deck: "Cells deck", front: { from: "Q2", to: "Q2 edited" }, back: "A $x^2$" });
  await A.run("addCard", { deck: "Cells deck", front: "Q3 manual", back: "Own words" });
  await B.run("deleteCard", { deck: "Cells deck", front: "Q1" });
  await A.run("sync");
  await B.run("sync");
  await A.run("sync");
  const [a5b, b5b] = [await A.run("state"), await B.run("state")];
  check("edited, added and deleted cards propagate; manual card (no citation) loads", () => {
    assert.deepEqual(a5b.Biology.decks[0].cards, ["Q2 edited:reps0", "Q3 manual:reps0"]);
    assert.deepEqual(a5b, b5b);
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

  // 12. A PDF source, then AI page readings appended on A: B picks up the new content revision.
  const contentFiles = () => readdirSync(driveDir).filter((f) => f.startsWith("source-")).sort();
  const tb = (st: any) => st.Chemistry.sources.find((x: any) => x.title === "Textbook");
  await A.run("pdfSource", { subject: "Chemistry", title: "Textbook" });
  await A.run("sync");
  await B.run("sync");
  const b12 = tb(await B.run("state"));
  check("B has the PDF at revision 0", () => {
    assert.equal(b12.rev, 0);
    assert.deepEqual(b12.ai, []);
    assert.equal(b12.chunks, 3);
    assert.equal(b12.invariantOk, true);
  });

  const reading = "Electrons orbit the nucleus in shells: $E_n = -13.6/n^2$ eV.";
  await A.run("aiRead", { title: "Textbook", page: 2, text: reading });
  await A.run("sync");
  const files13 = contentFiles();
  await B.run("sync");
  const [a13, b13] = [await A.run("state"), await B.run("state")];
  check("AI reading reaches B: new revision, appended text, chunks, invariant", () => {
    assert.equal(tb(b13).rev, 1);
    assert.deepEqual(tb(b13).ai, [`2:${reading}`]);
    assert.equal(tb(b13).chunks, 4);
    assert.deepEqual(tb(b13).readingChunks, [`2:${reading}`]);
    assert.equal(tb(b13).invariantOk, true);
    assert.deepEqual(tb(a13), tb(b13));
  });
  check("the changed content is a new Drive file (.r1); the superseded revision is removed", () => {
    assert.equal(files13.filter((f) => /\.r1(-[a-z0-9]+)?\.json\.gz$/.test(f)).length, 1, files13.join(","));
    // Every other source keeps its plain file; the Textbook has exactly one content file, at revision 1.
    assert.equal(files13.length, new Set(files13.map((f) => f.replace(/\.r\d+(-[a-z0-9]+)?\.json\.gz$/, ".json.gz"))).size);
  });

  // 13. Re-reading a page replaces its reading everywhere; only the newest reading of a page is indexed.
  await A.run("aiRead", { title: "Textbook", page: 2, text: "Electrons occupy energy levels." });
  await A.run("aiRead", { title: "Textbook", page: 3, text: "Ions form when atoms gain or lose electrons." });
  await A.run("sync");
  await B.run("sync");
  const [a14, b14] = [await A.run("state"), await B.run("state")];
  check("a re-read page and a new page reach B; superseded revisions leave Drive", () => {
    assert.equal(tb(b14).rev, 3);
    assert.deepEqual(tb(b14).ai, ["2:Electrons occupy energy levels.", "3:Ions form when atoms gain or lose electrons."]);
    assert.deepEqual(tb(b14).readingChunks, ["2:Electrons occupy energy levels.", "3:Ions form when atoms gain or lose electrons."]);
    assert.equal(tb(b14).invariantOk, true);
    assert.deepEqual(tb(a14), tb(b14));
    assert.ok(contentFiles().some((f) => /\.r3(-[a-z0-9]+)?\.json\.gz$/.test(f)));
    assert.ok(!contentFiles().some((f) => /\.r1(-[a-z0-9]+)?\.json\.gz$/.test(f)));
  });

  // 14. A later, unrelated edit on a device that is behind must not undo the content revision.
  await A.run("aiRead", { title: "Textbook", page: 1, text: "Atoms are the basic units of matter." });
  await wait(20);
  await B.run("setChecked", { title: "Textbook", checked: false });
  await A.run("sync");
  await B.run("sync");
  await A.run("sync");
  const [a15, b15] = [await A.run("state"), await B.run("state")];
  check("a stale device's newer metadata edit keeps the content revision; devices converge", () => {
    assert.equal(tb(b15).rev, 4);
    assert.equal(tb(b15).checked, false);
    assert.deepEqual(tb(b15).ai.map((x: string) => x.split(":")[0]), ["1", "2", "3"]);
    assert.equal(tb(b15).invariantOk, true);
    assert.deepEqual(tb(a15), tb(b15));
  });

  // 15. Concurrent readings: both devices read a different page of the same PDF before syncing. Neither
  // reading may be lost, whichever device syncs first, and the result must be consistent on both.
  for (const [title, order] of [["Lab A-first", ["A", "B", "A", "B"]], ["Lab B-first", ["B", "A", "B", "A"]]] as const) {
    await A.run("pdfSource", { subject: "Chemistry", title });
    await A.run("sync");
    await B.run("sync");
    await A.run("aiRead", { title, page: 2, text: "Reading of page two from A." });
    await B.run("aiRead", { title, page: 3, text: "Reading of page three from B." });
    const dev = { A, B };
    for (const d of order) await dev[d].run("sync");
    const [ac, bc] = [await A.run("state"), await B.run("state")];
    const get = (st: any) => st.Chemistry.sources.find((x: any) => x.title === title);
    check(`concurrent readings of different pages merge on both devices (${title})`, () => {
      for (const st of [get(ac), get(bc)]) {
        assert.deepEqual(st.ai, ["2:Reading of page two from A.", "3:Reading of page three from B."]);
        assert.deepEqual(st.readingChunks, ["2:Reading of page two from A.", "3:Reading of page three from B."]);
        assert.equal(st.invariantOk, true);
        assert.equal(st.ordsUnique, true);
        assert.equal(st.chunks, 5);
      }
      assert.deepEqual(get(ac), get(bc));
    });
  }

  // 16. A source's content file can't be uploaded (flaky network): the library, deck and cards must still reach
  // Drive, and the other device gets them. Once the fault clears, the source follows.
  const library = () => JSON.parse(readFileSync(path.join(driveDir, "library.json.gz"), "utf8"));
  const sourceFiles = () => readdirSync(driveDir).filter((f) => f.startsWith("source-")).length;
  const decksOf = (st: any, subject: string) => st[subject]?.decks ?? [];
  await A.run("subject", { name: "Faulty" });
  await A.run("source", { subject: "Faulty", title: "Big" });
  await A.run("deck", { subject: "Faulty", source: "Big", title: "Faulty deck" });
  const filesBefore = sourceFiles();
  await A.run("fault", { write: true });
  const ra = await A.run("sync");
  check("upload failure: library with the deck and cards is still written; report names the failed source", () => {
    const lib = library();
    const deck = lib.artifacts.find((x: any) => x.title === "Faulty deck");
    assert.ok(deck);
    assert.equal(lib.cards.filter((c: any) => c.deck === deck.uid).length, 2);
    assert.equal(sourceFiles(), filesBefore);
    assert.deepEqual(ra.report.uploadFailed, ["Big"]);
    assert.ok(ra.report.sent.cards >= 2 && ra.report.sent.items >= 1 && ra.report.sent.subjects >= 1);
    assert.ok(ra.report.inDrive.cards >= 2);
  });
  const rb = await B.run("sync");
  const b16 = await B.run("state");
  check("B gets the deck and its cards; the source is reported missing", () => {
    assert.deepEqual(decksOf(b16, "Faulty").map((d: any) => [d.title, d.cards.length]), [["Faulty deck", 2]]);
    assert.deepEqual(b16.Faulty.sources, []);
    assert.equal(rb.missing.length, 1);
    assert.ok(rb.report.received.cards >= 2 && rb.report.received.items >= 1);
    assert.deepEqual(rb.report.uploadFailed, []);
  });
  await A.run("fault");
  const ra2 = await A.run("sync");
  await B.run("sync");
  const b16b = await B.run("state");
  check("after the fault clears the source uploads and B receives it", () => {
    assert.deepEqual(ra2.report.uploadFailed, []);
    assert.equal(sourceFiles(), filesBefore + 1);
    assert.deepEqual(b16b.Faulty.sources, [{ title: "Big", status: "ready", chunks: 3, textOk: true }]);
    assert.equal(b16b.Faulty.decks[0].citation, "Gamma paragraph.");
  });

  // 17. B can't download a source's content file: it still gets the deck and cards, and keeps the source in the library.
  await A.run("subject", { name: "Reader" });
  await A.run("source", { subject: "Reader", title: "Heavy" });
  await A.run("deck", { subject: "Reader", source: "Heavy", title: "Reader deck" });
  await A.run("sync");
  await B.run("fault", { read: true });
  const rb2 = await B.run("sync");
  const b17 = await B.run("state");
  check("failed download: B still gets the deck and cards; report names the source; library keeps it", () => {
    assert.deepEqual(decksOf(b17, "Reader").map((d: any) => [d.title, d.cards.length]), [["Reader deck", 2]]);
    assert.deepEqual(b17.Reader.sources, []);
    assert.deepEqual(rb2.report.downloadFailed, ["Heavy"]);
    assert.ok(library().sources.some((s: any) => s.title === "Heavy"));
  });
  await B.run("fault");
  await B.run("sync");
  const b17b = await B.run("state");
  check("after the fault clears B downloads the source", () => {
    assert.deepEqual(b17b.Reader.sources.map((s: any) => s.title), ["Heavy"]);
  });

  // 18. Items that cite a source this device doesn't have yet (its upload failed): the references survive on
  // Drive and on the original device whatever the receiving device does, and resolve once the source arrives.
  await A.run("subject", { name: "Cites" });
  await A.run("source", { subject: "Cites", title: "Src" });
  await A.run("deck", { subject: "Cites", source: "Src", title: "Cites deck" });
  await A.run("conversation", { subject: "Cites", title: "Cites chat", source: "Src" });
  await A.run("conversation", { subject: "Cites", title: "Cites margin", source: "Src", kind: "margin" });
  await A.run("fault", { write: true });
  await A.run("sync");
  await B.run("sync");
  await B.run("sync");
  const refsIntact = () => {
    const lib = library();
    const srcUid = lib.sources.find((s: any) => s.title === "Src").uid;
    const deck = lib.artifacts.find((x: any) => x.title === "Cites deck");
    const chat = lib.threads.find((t: any) => t.title === "Cites chat");
    const margin = lib.threads.find((t: any) => t.title === "Cites margin");
    return (
      deck.passages.every((p: any) => p.source === srcUid && p.chunk_ord === 2) &&
      deck.params.source_ids.length === 1 && deck.params.source_ids[0] === srcUid &&
      chat.turns.flatMap((t: any) => t.citations ?? []).every((c: any) => c.source === srcUid && c.chunk_ord === 2) &&
      margin.source === srcUid
    );
  };
  check("B's two syncs while the source is missing leave every reference on Drive intact", () => assert.ok(refsIntact()));
  // B edits the deck (a newer updated_at) while the source is missing; A syncs it back.
  await B.run("touchDeck", { title: "Cites deck" });
  await B.run("sync");
  await A.run("sync");
  const a18 = await A.run("state");
  check("B's edit while the source is missing doesn't wipe citations on Drive or on A", () => {
    assert.ok(refsIntact());
    assert.equal(a18.Cites.decks[0].citation, "Gamma paragraph.");
    assert.ok(a18.Cites.decks[0].paramsOk);
    assert.deepEqual(a18.Cites.conversations.map((c: any) => c.citation), ["Gamma paragraph.", "Gamma paragraph."]);
  });
  await A.run("fault");
  await A.run("sync");
  const rb18 = await B.run("sync");
  const b18 = await B.run("state");
  check("once the source arrives B's deck, conversation and margin thread are repaired (and counted as updates)", () => {
    assert.deepEqual(b18.Cites.sources.map((s: any) => s.title), ["Src"]);
    assert.equal(b18.Cites.decks[0].citation, "Gamma paragraph.");
    assert.ok(b18.Cites.decks[0].paramsOk);
    assert.deepEqual(b18.Cites.conversations.map((c: any) => c.citation), ["Gamma paragraph.", "Gamma paragraph."]);
    assert.ok(rb18.updated >= 3);
    assert.ok(refsIntact());
  });

  // 19. A new device when Drive only has an older revision of a source: it gets that revision, nothing is deleted.
  await A.run("subject", { name: "Revs" });
  await A.run("pdfSource", { subject: "Revs", title: "Old" });
  await A.run("sync");
  await A.run("fault", { write: true });
  await A.run("aiRead", { title: "Old", page: 2, text: "A reading that fails to upload." });
  const ra19 = await A.run("sync");
  const C = device("C");
  try {
    await C.run("sync");
    const old = (st: any) => st.Revs.sources.find((x: any) => x.title === "Old");
    const c19 = old(await C.run("state"));
    check("new device gets the older revision when the newest isn't on Drive; the older file is kept", () => {
      assert.deepEqual(ra19.report.uploadFailed, ["Old"]);
      assert.equal(c19.rev, 0);
      assert.equal(c19.chunks, 3);
      assert.equal(c19.invariantOk, true);
      assert.ok(readdirSync(driveDir).some((f) => /^source-.*\.json\.gz$/.test(f) && !/\.r\d/.test(f) && readFileSync(path.join(driveDir, f), "utf8").includes("Atoms have a nucleus.")));
    });
    await A.run("fault");
    await A.run("sync");
    await C.run("sync");
    const c19b = old(await C.run("state"));
    check("when the newest revision is uploaded, the new device adopts it", () => {
      assert.equal(c19b.rev, 1);
      assert.deepEqual(c19b.ai, ["2:A reading that fails to upload."]);
      assert.equal(c19b.invariantOk, true);
    });
  } finally {
    C.stop();
  }

  console.log(`\nALL ${passed} SYNC CHECKS PASSED`);
} finally {
  A.stop();
  B.stop();
  if (existsSync(driveDir)) rmSync(driveDir, { recursive: true, force: true });
}
