import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "./server.mjs";
import { normalizeAndroidHierarchy } from "./android-runtime.mjs";
import { compareObservations } from "./execution-observations.mjs";

test("terminal decoding loss is unknown in both native and ordinary execution summaries", async () => {
  const capture = {
    normalized_result: {
      frames: [{ data: "�\n" }],
      exit: { code: 0, signal: 0, reason: "exited" },
      settlement: { state: "quiesced" },
      truncated: false,
      residual_unknowns: [{ scope: "terminal", reason: "invalid UTF-8" }],
    },
  };
  assert.equal(compareObservations(capture, capture).output_equal, null);
  const { executionObservations } = await import("./operations.mjs");
  assert.equal(executionObservations(capture, capture).output_equal, null);
});

test("Android comparisons retain parent-child paths as well as node order", () => {
  const n = (text, children = "") =>
    `<node package="com.example.review" text="${text}">${children}</node>`;
  const a = `<hierarchy>${n("root", n("A") + n("B", n("C")))}</hierarchy>`;
  const b = `<hierarchy>${n("root", n("A", n("B", n("C"))))}</hierarchy>`;
  assert.notDeepEqual(
    normalizeAndroidHierarchy(a, "com.example.review"),
    normalizeAndroidHierarchy(b, "com.example.review"),
  );
});

async function client(ui) {
  const login = await fetch(ui.url, { redirect: "manual" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  return (path, data) =>
    fetch(ui.base + path, {
      headers: {
        Cookie: cookie,
        Origin: ui.base,
        "Content-Type": "application/json",
        "X-REA-Request": "1",
      },
      ...(data === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(data) }),
    });
}

test("second server cannot interrupt live history; shutdown refuses work and waits final cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-adversarial-"));
  let release, entered;
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  let ui;
  try {
    ui = await startServer({
      stateDir: root,
      runner: async () => {
        entered();
        await gate;
        return { done: true };
      },
    });
    const request = await client(ui),
      first = await (
        await request("/api/jobs", {
          action: "resume",
          project: join(root, "project"),
        })
      ).json();
    await started;
    await assert.rejects(startServer({ stateDir: root }), /이미 실행 중/);
    const saved = JSON.parse(
      await readFile(join(root, "jobs", first.id, "job.json"), "utf8"),
    );
    assert.equal(saved.status, "running");
    assert.equal((await request("/api/shutdown", {})).status, 409);
    const closing = ui.close();
    await assert.rejects(startServer({ stateDir: root }), /이미 실행 중/);
    release();
    await closing;
    ui = null;
    const next = await startServer({ stateDir: root });
    try {
      const second = await client(next);
      assert.equal(
        (await (await second("/api/jobs/" + first.id)).json()).status,
        "cancelled",
      );
    } finally {
      await next.close();
    }
  } finally {
    release?.();
    if (ui) await ui.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed listen releases only its own workspace ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-listen-failure-"));
  const a = await startServer({ stateDir: join(root, "a") });
  try {
    await assert.rejects(
      startServer({ stateDir: join(root, "b"), port: a.server.address().port }),
      /EADDRINUSE/,
    );
    const b = await startServer({ stateDir: join(root, "b") });
    await b.close();
  } finally {
    await a.close();
    await rm(root, { recursive: true, force: true });
  }
});
