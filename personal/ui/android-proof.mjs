// Opt-in real provider proof; no SDK downloads or license acceptance.
// node personal/ui/android-proof.mjs ORIGINAL_APK REBUILT_APK OUTPUT SDK JAVA [SERIAL] [AVD]
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { signAndVerifyApk } from "./android-runtime.mjs";

const cancelProof = process.argv.includes("--cancel-after-launch");
const [
  original,
  candidate,
  output,
  androidSdk,
  java,
  serial = "emulator-5580",
  avdName = "personal_rea_api35",
] = process.argv.slice(2).filter((arg) => arg !== "--cancel-after-launch");
if (!original || !candidate || !output || !androidSdk || !java)
  throw new Error(
    "Required: ORIGINAL_APK REBUILT_APK OUTPUT SDK JAVA [SERIAL] [AVD]",
  );
await mkdir(output, { mode: 0o700 });
const controller = new AbortController();
let timer;
if (cancelProof)
  timer = setInterval(async () => {
    try {
      const r = JSON.parse(
        await readFile(join(output, "android-runtime", "receipt.json"), "utf8"),
      );
      if (
        r.commands.some((c) => c.name === "original launch" && c.exitCode === 0)
      )
        controller.abort(new Error("Proof cancellation after real launch"));
    } catch {
      /* The atomic job receipt may not yet exist or be between writes. */
    }
  }, 100);
let result;
try {
  result = await signAndVerifyApk(
    {
      original,
      candidate,
      androidSdk,
      java,
      serial,
      avdName,
      executeAcknowledged: true,
      scenarios: [
        { name: "initial-launch", waitMs: 3000 },
        {
          name: "accessibility-menu",
          taps: [{ x: 170, y: 350 }],
          waitMs: 1200,
        },
        { name: "return", keys: ["BACK"], waitMs: 1200 },
      ],
    },
    output,
    controller.signal,
  );
} catch (error) {
  if (!cancelProof || !controller.signal.aborted) throw error;
} finally {
  clearInterval(timer);
}
if (cancelProof) {
  assert.equal(result, undefined);
  const r = JSON.parse(
    await readFile(join(output, "android-runtime", "receipt.json"), "utf8"),
  );
  assert.equal(r.status, "cancelled");
  assert.equal(r.cleanup[0].status, "complete");
  assert.equal(r.cleanup[0].installed_by_job, true);
  assert.notEqual(r.emulator.stop.status, "incomplete");
  console.log(
    JSON.stringify(
      { status: r.status, cleanup: r.cleanup, emulator_stop: r.emulator.stop },
      null,
      2,
    ),
  );
  process.exit(0);
}
assert.equal(result.signing, "verified");
assert.equal(result.status, "verified");
assert.equal(result.cleanup.filter((c) => c.status === "complete").length, 2);
assert.equal(result.comparison.length, 3);
console.log(
  JSON.stringify(
    {
      status: result.status,
      behavior: result.behavior,
      comparison: result.comparison,
      receipt_path: result.receipt_path,
    },
    null,
    2,
  ),
);
