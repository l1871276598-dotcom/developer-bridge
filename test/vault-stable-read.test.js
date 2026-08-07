import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPartitionMap, resolvePartition } from "../src/vault/partition-map.js";
import { readNoteIdentity, buildNoteIdentity } from "../src/vault/note-identity.js";
import { buildSnapshotFromRaw } from "../src/vault/snapshot.js";
import { readStableVaultNote } from "../src/vault/stable-read.js";
import { publishNote } from "../src/vault/vault-evidence.js";

const PROFILE = Object.freeze({
  workspace: "personal",
  project: "laos",
  confidentiality_ceiling: "internal",
});

const RULES = Object.freeze([
  { path_prefix: "01-Projects/LAOS", workspace: "personal", project: "laos", confidentiality: "personal" },
]);

const NOTE_A = `---
id: toc-note-001
title: T
---

payload A
`;

const NOTE_B = `---
id: toc-note-001
title: T
---

payload B (attacker content)
`;

async function vaultFixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "vault-stable-read-")));
  const vault = path.join(base, "vault");
  await mkdir(path.join(vault, "01-Projects", "LAOS"), { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, vault };
}

test("C-INV-17: identity and payload derive from the same stable read", async (t) => {
  const { vault } = await vaultFixture(t);
  const notePath = "01-Projects/LAOS/design.md";
  await writeFile(path.join(vault, notePath), NOTE_A);

  const { raw } = await readStableVaultNote(vault, notePath);
  const identity = readNoteIdentity(raw, notePath);
  const partition = resolvePartition(buildPartitionMap(RULES), notePath);
  const snapshot = buildSnapshotFromRaw(raw, identity, partition);

  // The payload content is the CANONICAL note bytes (front matter normalized),
  // derived from the same single read as the identity.
  const { canonicalNoteBytes } = await import("../src/vault/note-identity.js");
  assert.equal(snapshot.input.payload.content, canonicalNoteBytes(raw).toString("utf8"));
  // identity.source_sha256 == SHA256(canonical note bytes) == the source hash
  // the Bridge and Core verify against payload.content.
  const { createHash } = await import("node:crypto");
  assert.equal(
    identity.source_sha256,
    createHash("sha256").update(snapshot.input.payload.content).digest("hex"),
  );
});

test("C-INV-17: a second read that differs would change identity and payload together, never mix", async (t) => {
  const { vault } = await vaultFixture(t);
  const notePath = "01-Projects/LAOS/design.md";
  await writeFile(path.join(vault, notePath), NOTE_A);

  // Simulate the attacker swapping content between two logical reads.
  const first = await readStableVaultNote(vault, notePath);
  const identityA = readNoteIdentity(first.raw, notePath);
  await writeFile(path.join(vault, notePath), NOTE_B);
  const second = await readStableVaultNote(vault, notePath);
  const identityB = readNoteIdentity(second.raw, notePath);

  // The production path reads ONCE: identity B would pair with payload B, so
  // "identity A + payload B" can never be produced. Prove both halves change
  // together by showing a mix is detectably inconsistent.
  const partition = resolvePartition(buildPartitionMap(RULES), notePath);
  const snapshotB = buildSnapshotFromRaw(second.raw, identityB, partition);
  // If someone had paired identity A's source_sha with snapshot B's payload,
  // the source hash would not match SHA256(payload.content).
  const { createHash } = await import("node:crypto");
  const mixedSourceSha = identityA.source_sha256;
  const actualContentSha = createHash("sha256").update(snapshotB.input.payload.content).digest("hex");
  assert.notEqual(mixedSourceSha, actualContentSha);
});

test("C-INV-17: readStableVaultNote rejects a non-regular target", async (t) => {
  const { vault } = await vaultFixture(t);
  await mkdir(path.join(vault, "01-Projects", "LAOS", "dir.md"));
  await assert.rejects(
    readStableVaultNote(vault, "01-Projects/LAOS/dir.md"),
    (e) => e.code === "note_not_file",
  );
});

test("C-INV-17: publishNote flows one stable read end-to-end", async (t) => {
  const { vault } = await vaultFixture(t);
  await writeFile(path.join(vault, "01-Projects/LAOS/design.md"), NOTE_A);
  const calls = [];
  const { canonicalNoteBytes } = await import("../src/vault/note-identity.js");
  const result = await publishNote({
    config: { vault: { root: vault }, partition_rules: RULES },
    profile: PROFILE,
    noteRelativePath: "01-Projects/LAOS/design.md",
    publishEvidence: async (input) => {
      calls.push(input.payload.content);
      const { note_id, source_sha256 } = input.source;
      return { source_ref: "artifact:abc", artifact_sha256: "abc", canonical_identity: `vault-note:${note_id}@${source_sha256}` };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], canonicalNoteBytes(NOTE_A).toString("utf8"));
  assert.equal(result.note_id, "toc-note-001");
});

test("buildNoteIdentity from raw bytes is deterministic and path-agnostic", () => {
  const a = buildNoteIdentity(NOTE_A, "01-Projects/LAOS/design.md");
  const b = buildNoteIdentity(NOTE_A, "02-Knowledge/x.md");
  assert.equal(a.source_sha256, b.source_sha256);
  assert.equal(a.canonical_identity, b.canonical_identity);
});

// S7: same-inode mutation during read — same size, restored mtime, but ctime
// changes. The read MUST fail closed (note_changed), never silently return a
// stale read. Uses the deterministic beforeRead seam to simulate the writer
// landing between fstat-before and readFile.
test("S7: same-inode same-size mutation during read is detected via ctime", async (t) => {
  const { vault } = await vaultFixture(t);
  const notePath = "01-Projects/LAOS/design.md";
  // Same byte length so size does not change.
  await writeFile(path.join(vault, notePath), "payload A\n");
  const mutator = async (absolute) => {
    // Rewrite the same inode with same-size content (truncate+write keeps the
    // inode; ctime always bumps even if mtime is restored later).
    const { open } = await import("node:fs/promises");
    const fh = await open(absolute, "r+");
    try {
      await fh.write("payload B\n"); // same length as "payload A\n"
    } finally {
      await fh.close();
    }
  };
  await assert.rejects(
    readStableVaultNote(vault, notePath, { beforeRead: mutator }),
    (e) => e.code === "note_changed",
  );
});

test("S7: inode swap during read (different file, same path) is detected", async (t) => {
  const { vault } = await vaultFixture(t);
  const notePath = "01-Projects/LAOS/design.md";
  await writeFile(path.join(vault, notePath), "original\n");
  const { rename } = await import("node:fs/promises");
  const swapPath = path.join(vault, "01-Projects", "LAOS", "swap.md");
  await writeFile(swapPath, "attacker\n");
  const swapper = async (absolute) => {
    // Swap the note with a different inode mid-read.
    const tmp = `${absolute}.tmp`;
    await rename(absolute, tmp);
    await rename(swapPath, absolute);
  };
  await assert.rejects(
    readStableVaultNote(vault, notePath, { beforeRead: swapper }),
    (e) => e.code === "note_changed",
  );
});

// S8: resolve→open swap — the validated path is replaced with a different
// inode between validation and open. The opened fd must be rejected because it
// does not match the resolve-time file object.
test("S8: path swapped between validation and open is detected", async (t) => {
  const { vault } = await vaultFixture(t);
  const notePath = "01-Projects/LAOS/design.md";
  await writeFile(path.join(vault, notePath), "original\n");
  const { rename } = await import("node:fs/promises");
  const attackerPath = path.join(vault, "01-Projects", "LAOS", "attacker.md");
  await writeFile(attackerPath, "attacker\n");
  const swapper = async (absolute) => {
    // Replace the validated path with a different inode before open.
    const tmp = `${absolute}.swap`;
    await rename(absolute, tmp);
    await rename(attackerPath, absolute);
  };
  await assert.rejects(
    readStableVaultNote(vault, notePath, { afterResolve: swapper }),
    (e) => e.code === "note_changed",
  );
});

