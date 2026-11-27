// Unit tests for the RGA text CRDT. No network, no server.
import { describe, expect, test } from "bun:test";
import { TextDoc, type Op } from "../src/shared/crdt";

const DOC = "doc-test";
const replica = (name: string) => new TextDoc(DOC, name);

/** Deterministic PRNG so a failing fuzz case can be replayed. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

describe("CRDT local editing", () => {
  test("[U1] insert and delete produce the expected text", () => {
    const a = replica("alice-1");
    a.insertText(0, "Hello world");
    a.deleteText(5, 6);
    a.insertText(5, ", DS04");
    expect(a.text()).toBe("Hello, DS04");
    expect(a.version).toBe(11 + 6 + 6);
  });

  test("[U2] every op carries ID, client ID, document ID, type and version info", () => {
    const a = replica("alice-1");
    const [op] = a.insertText(0, "x");
    expect(op).toMatchObject({ id: "alice-1:1", client: "alice-1", doc: DOC, kind: "insert", seq: 1, clock: 1 });
  });
});

describe("CRDT concurrency", () => {
  test("[U3] two replicas insert at the same position at the same time: both converge, no text lost", () => {
    const a = replica("alice-1");
    const b = replica("bob-1");
    const base = a.insertText(0, "AB");
    b.apply(base);

    const fromA = a.insertText(1, "xx"); // A x x B
    const fromB = b.insertText(1, "yy"); // A y y B
    a.apply(fromB);
    b.apply(fromA);

    expect(a.text()).toBe(b.text());
    expect(a.text().length).toBe(6);
    expect(a.text()).toMatch(/^A(xxyy|yyxx)B$/); // each run stays together
  });

  test("[U4] insert inside a range that another replica deletes: insert survives, delete removes only old text", () => {
    const a = replica("alice-1");
    const b = replica("bob-1");
    b.apply(a.insertText(0, "0123456789"));

    const del = a.deleteText(2, 6); // remove "234567"
    const ins = b.insertText(5, "NEW"); // inside the deleted range
    a.apply(ins);
    b.apply(del);

    expect(a.text()).toBe("01NEW89");
    expect(b.text()).toBe("01NEW89");
  });

  test("[U5] both replicas delete the same characters: result is applied once", () => {
    const a = replica("alice-1");
    const b = replica("bob-1");
    b.apply(a.insertText(0, "abcdef"));
    const d1 = a.deleteText(1, 3);
    const d2 = b.deleteText(2, 3);
    a.apply(d2);
    b.apply(d1);
    expect(a.text()).toBe("af");
    expect(b.text()).toBe("af");
  });
});

describe("CRDT delivery faults", () => {
  test("[U6] duplicate ops are ignored", () => {
    const a = replica("alice-1");
    const b = replica("bob-1");
    const ops = a.insertText(0, "hi");
    expect(b.apply(ops).applied.length).toBe(2);
    const again = b.apply(ops);
    expect(again.applied.length).toBe(0);
    expect(again.duplicates).toBe(2);
    expect(b.text()).toBe("hi");
  });

  test("[U7] out-of-order ops wait in a buffer until their dependency arrives", () => {
    const a = replica("alice-1");
    const b = replica("bob-1");
    const ops = a.insertText(0, "abc");
    const first = b.apply([ops[2]!, ops[1]!]);
    expect(first.applied.length).toBe(0);
    expect(first.buffered).toBe(2);
    expect(b.text()).toBe("");
    const rest = b.apply([ops[0]!]);
    expect(rest.applied.length).toBe(3);
    expect(b.text()).toBe("abc");
  });

  test("[U8] missingFor returns only the ops a peer does not have", () => {
    const a = replica("alice-1");
    const b = replica("bob-1");
    const first = a.insertText(0, "abc");
    b.apply(first);
    a.insertText(3, "de");
    const missing = a.missingFor(b.stateVector());
    expect(missing.map((o) => o.id)).toEqual(["alice-1:4", "alice-1:5"]);
  });

  test("[U9] cursor anchors follow remote edits", () => {
    const a = replica("alice-1");
    const b = replica("bob-1");
    b.apply(a.insertText(0, "hello"));
    const anchor = b.anchorAt(3); // cursor between "hel" and "lo"
    b.apply(a.insertText(0, ">> "));
    expect(b.positionOf(anchor)).toBe(6);
    b.apply(a.deleteText(3, 5)); // delete the whole word, anchor item becomes a tombstone
    expect(b.positionOf(anchor)).toBe(3);
  });
});

describe("CRDT convergence fuzz", () => {
  test("[U10] 300 random runs: 3 replicas, random edits, shuffled + duplicated delivery, always converge", () => {
    for (let run = 0; run < 300; run++) {
      const rand = rng(run + 1);
      const names = ["alice-1", "bob-2", "carol-3"];
      const reps = names.map(replica);
      const inbox: Op[][] = reps.map(() => []);
      const all: Op[] = [];

      for (let step = 0; step < 40; step++) {
        const r = Math.floor(rand() * reps.length);
        const doc = reps[r]!;
        const len = doc.text().length;
        let ops: Op[];
        if (len > 0 && rand() < 0.4) {
          const pos = Math.floor(rand() * len);
          ops = doc.deleteText(pos, 1 + Math.floor(rand() * Math.min(4, len - pos)));
        } else {
          const pos = Math.floor(rand() * (len + 1));
          ops = doc.insertText(pos, "xyz".slice(0, 1 + Math.floor(rand() * 3)) + r);
        }
        all.push(...ops);
        inbox.forEach((box, i) => i !== r && box.push(...ops));

        // Deliver a random part of each inbox, shuffled, sometimes twice.
        reps.forEach((rep, i) => {
          const box = inbox[i]!;
          const take = Math.floor(rand() * (box.length + 1));
          const batch = shuffle(box.splice(0, take), rand);
          rep.apply(batch);
          if (rand() < 0.2) rep.apply(batch);
        });
      }
      reps.forEach((rep, i) => rep.apply(shuffle(inbox[i]!, rand)));

      const fresh = replica("observer-9");
      fresh.apply(shuffle([...all], rand));

      const texts = reps.map((r) => r.text());
      expect(new Set(texts).size).toBe(1);
      expect(fresh.text()).toBe(texts[0]!);
      reps.forEach((r) => expect(r.pendingCount).toBe(0));
    }
  });
});
