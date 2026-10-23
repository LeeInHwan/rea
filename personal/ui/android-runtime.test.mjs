import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import {
  parseApkIdentity,
  normalizeAndroidHierarchy,
  validateAndroidScenarios,
  signAndVerifyApk,
  finishAndroidDeviceLease,
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
      signAndVerifyApk(
        { androidSdk: join(dir, "missing") },
        relative(process.cwd(), failed),
      ),
      (error) => isAbsolute(error.receipt_path),
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

test("unresolved Android package cleanup retains its exact device lease and blocks reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-device-lease-"));
  const lease = { path: join(root, "verification.lock"), token: "owned-token" };
  try {
    await writeFile(
      lease.path,
      JSON.stringify({ token: lease.token, receipt_path: "receipt.json" }),
    );
    await assert.rejects(
      finishAndroidDeviceLease(lease, {
        cleanup: [
          { label: "original", status: "complete" },
          { label: "candidate", status: "unresolved" },
        ],
      }),
      /retaining device lease/,
    );
    await assert.rejects(
      writeFile(lease.path, "next job", { flag: "wx" }),
      /EEXIST/,
    );
    assert.equal(JSON.parse(await readFile(lease.path)).token, lease.token);
    await assert.rejects(
      finishAndroidDeviceLease({ ...lease, token: "foreign" }, { cleanup: [] }),
      /identity changed/,
    );
    await finishAndroidDeviceLease(lease, {
      cleanup: [{ status: "complete" }],
    });
    await assert.rejects(readFile(lease.path), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
