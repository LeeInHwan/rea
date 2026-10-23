import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseApkIdentity,
  normalizeAndroidHierarchy,
  validateAndroidScenarios,
  signAndVerifyApk,
} from "./android-runtime.mjs";

test("APK identity preserves package/version/activity and rejects shell-bearing identities", () => {
  assert.deepEqual(
    parseApkIdentity(
      "package: name='com.example.app' versionCode='4' versionName='1.2'\nlaunchable-activity: name='com.example.app.Main'",
    ),
    {
      package: "com.example.app",
      version_code: "4",
      version_name: "1.2",
      activity: "com.example.app.Main",
    },
  );
  assert.throws(() =>
    parseApkIdentity(
      "package: name='com.foo;id' versionCode='1' versionName='1'",
    ),
  );
  assert.throws(() =>
    parseApkIdentity(
      "package: name='com.foo' versionCode='1' versionName='1'\nlaunchable-activity: name='Main;id'",
    ),
  );
});

test("UI comparison excludes system clock while retaining target text, geometry and checked state", () => {
  const xml = (text) =>
    `<hierarchy><node package="com.android.systemui" text="${text}"/><node package="com.example.app" text="Hello" checked="true" bounds="[0,0][100,200]"/></hierarchy>`;
  assert.deepEqual(
    normalizeAndroidHierarchy(xml("10:00"), "com.example.app"),
    normalizeAndroidHierarchy(xml("10:01"), "com.example.app"),
  );
  assert.notDeepEqual(
    normalizeAndroidHierarchy(xml("10:00"), "com.example.app"),
    normalizeAndroidHierarchy(
      xml("10:00").replace("Hello", "Changed"),
      "com.example.app",
    ),
  );
  assert.throws(() =>
    normalizeAndroidHierarchy("<hierarchy/>", "com.example.app"),
  );
  assert.throws(() =>
    normalizeAndroidHierarchy(
      "<hierarchy><node></hierarchy>",
      "com.example.app",
    ),
  );
});

test("scenarios have bounded explicit tap/key operations and preserve order", () => {
  assert.deepEqual(
    validateAndroidScenarios([
      {
        name: "navigate",
        taps: [{ x: 20, y: 50 }],
        keys: ["BACK"],
        waitMs: 50,
      },
    ])[0],
    {
      name: "navigate",
      index: 0,
      taps: [{ x: 20, y: 50 }],
      keys: ["BACK"],
      waitMs: 50,
    },
  );
  for (const value of [
    [],
    [{ name: "x", command: "rm" }],
    [{ name: "x", keys: ["HOME"] }],
    [{ name: "x", taps: [{ x: -1, y: 1 }] }],
    [{ name: "x", waitMs: 10001 }],
  ])
    assert.throws(() => validateAndroidScenarios(value));
});

test("prerequisite failure and cancellation retain a failed/cancelled receipt without signing claims", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rea-android-"));
  try {
    const failed = join(dir, "failed");
    const cancelled = join(dir, "cancelled");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(failed);
    await mkdir(cancelled);
    await assert.rejects(
      signAndVerifyApk({ androidSdk: join(dir, "missing") }, failed),
    );
    const receipt = JSON.parse(
      await readFile(join(failed, "android-runtime", "receipt.json")),
    );
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.signing, "not-run");
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      signAndVerifyApk(
        { androidSdk: join(dir, "missing") },
        cancelled,
        ac.signal,
      ),
    );
    assert.equal(
      JSON.parse(
        await readFile(join(cancelled, "android-runtime", "receipt.json")),
      ).status,
      "cancelled",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
