import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  realpath,
  chmod,
  unlink,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DOMParser } from "@xmldom/xmldom";
import { owned, fileDigest } from "../workbench/managed-restore.mjs";
import { json } from "../workbench/store.mjs";
import { prepareOwnedCommand } from "../../dist/process/OwnedCommand.js";
import {
  spawnOwnedProviderProcess,
  ProviderProcessSupervisor,
} from "../../dist/process/ProviderProcess.js";

export const ANDROID_BUILD_TOOLS = "35.0.0";
export const ANDROID_PLATFORM_TOOLS = "37.0.0";
const pendingEmulatorCleanup = new Set();

export function parseApkIdentity(badging) {
  const pkg =
    /^package: name='([^']+)' versionCode='([^']*)' versionName='([^']*)'/m.exec(
      badging,
    );
  const activity = /^launchable-activity: name='([^']+)'/m.exec(badging)?.[1];
  if (!pkg || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(pkg[1]))
    throw new Error("APK package identity could not be established");
  if (activity && !/^[A-Za-z0-9_.$]+$/.test(activity))
    throw new Error("Invalid launch activity");
  return {
    package: pkg[1],
    version_code: pkg[2],
    version_name: pkg[3],
    activity: activity ?? null,
  };
}

export function normalizeAndroidHierarchy(xml, packageName) {
  const errors = [];
  const doc = new DOMParser({
    onError: (level, message) => errors.push(`${level}: ${message}`),
  }).parseFromString(xml, "application/xml");
  if (errors.length || doc.documentElement?.tagName !== "hierarchy")
    throw new Error("Invalid Android UI hierarchy");
  const nodes = Array.from(doc.getElementsByTagName("node")).filter(
    (n) => n.getAttribute("package") === packageName,
  );
  if (!nodes.length) throw new Error("Target package has no visible UI nodes");
  const attributes = [
    "text",
    "resource-id",
    "class",
    "content-desc",
    "checkable",
    "checked",
    "clickable",
    "enabled",
    "focusable",
    "focused",
    "scrollable",
    "selected",
    "bounds",
  ];
  return nodes.map((node) =>
    Object.fromEntries(attributes.map((key) => [key, node.getAttribute(key)])),
  );
}

export function validateAndroidScenarios(value) {
  const scenarios = value ?? [{ name: "launch", waitMs: 1500 }];
  if (!Array.isArray(scenarios) || scenarios.length < 1 || scenarios.length > 5)
    throw new Error("1–5 Android scenarios required");
  return scenarios.map((s, i) => {
    if (
      !s ||
      typeof s !== "object" ||
      Object.keys(s).some(
        (k) => !["name", "taps", "keys", "waitMs"].includes(k),
      )
    )
      throw new Error("Invalid Android scenario");
    if (typeof s.name !== "string" || !s.name.length || s.name.length > 80)
      throw new Error("Scenario name required");
    const taps = s.taps ?? [],
      keys = s.keys ?? [],
      waitMs = s.waitMs ?? 1500;
    if (
      !Array.isArray(taps) ||
      taps.length > 10 ||
      taps.some(
        (p) =>
          !p ||
          Object.keys(p).some((k) => !["x", "y"].includes(k)) ||
          !Number.isInteger(p.x) ||
          !Number.isInteger(p.y) ||
          p.x < 0 ||
          p.y < 0 ||
          p.x > 4096 ||
          p.y > 4096,
      )
    )
      throw new Error("Invalid Android tap coordinates");
    if (
      !Array.isArray(keys) ||
      keys.length > 10 ||
      keys.some((k) => !["BACK", "ENTER", "TAB"].includes(k))
    )
      throw new Error("Invalid Android key");
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10000)
      throw new Error("Invalid Android wait");
    return { name: s.name, index: i, taps, keys, waitMs };
  });
}

export async function signAndVerifyApk(input, directory, signal) {
  const output = join(directory, "android-runtime");
  await mkdir(output, { mode: 0o700 });
  const receiptPath = join(output, "receipt.json");
  const receipt = {
    schema_version: 1,
    status: "running",
    signing: "not-run",
    behavior: "not-run",
    commands: [],
    cleanup: [],
    limitations: [
      "Dedicated local test signature; original signing identity, signature permissions and store updates are not preserved.",
      "UI hierarchy, foreground process and crash observations cover only the selected finite scenarios; they do not establish full application equivalence.",
      "Screenshots are retained independently; pixel equality is not a semantic-equivalence verdict.",
    ],
  };
  const save = () => writeFile(receiptPath, json(receipt), { mode: 0o600 });
  let emulatorOwner, deviceLease;
  const run = async (name, command, args, timeout = 30000, cleanup = false) => {
    if (!cleanup) signal?.throwIfAborted();
    try {
      const result = await owned(
        command,
        args,
        output,
        timeout,
        cleanup ? undefined : signal,
      );
      receipt.commands.push({ name, command, arguments: args, ...result });
      await save();
      if (
        result.exitCode !== 0 ||
        result.diagnosticTruncated ||
        result.stdout.invalidUtf8 ||
        result.stderr.invalidUtf8
      )
        throw new Error(`${name} failed; see ${receiptPath}`);
      return result.stdout.text;
    } catch (error) {
      receipt.commands.push({
        name,
        error: error.message,
        snapshot: error.snapshot ?? null,
        resources: error.resources ?? null,
      });
      await save();
      throw error;
    }
  };
  try {
    const sdk = await realpath(input.androidSdk);
    const java = await realpath(input.java);
    const build = join(sdk, "build-tools", ANDROID_BUILD_TOOLS);
    for (const [root, version] of [
      [build, ANDROID_BUILD_TOOLS],
      [join(sdk, "platform-tools"), ANDROID_PLATFORM_TOOLS],
    ]) {
      const props = await readFile(join(root, "source.properties"), "utf8");
      if (
        !new RegExp(
          `^Pkg.Revision\\s*=\\s*${version.replaceAll(".", "\\.")}\\s*$`,
          "m",
        ).test(props)
      )
        throw new Error(`Required pinned Android tool version: ${version}`);
    }
    const aapt = join(build, "aapt"),
      zipalign = join(build, "zipalign"),
      signerJar = join(build, "lib", "apksigner.jar"),
      adb = join(sdk, "platform-tools", "adb");
    receipt.tools = {
      build_tools: ANDROID_BUILD_TOOLS,
      platform_tools: ANDROID_PLATFORM_TOOLS,
      files: await Promise.all(
        [java, aapt, zipalign, signerJar, adb].map(async (path) => ({
          path,
          sha256: await fileDigest(path),
        })),
      ),
    };
    const originalPath = await realpath(input.original),
      candidatePath = await realpath(input.candidate);
    receipt.original = {
      path: originalPath,
      sha256: await fileDigest(originalPath),
    };
    receipt.candidate = {
      path: candidatePath,
      sha256: await fileDigest(candidatePath),
    };
    const original = join(output, "original.apk"),
      candidate = join(output, "candidate-unsigned.apk");
    await copyFile(originalPath, original);
    await copyFile(candidatePath, candidate);
    if (
      (await fileDigest(original)) !== receipt.original.sha256 ||
      (await fileDigest(candidate)) !== receipt.candidate.sha256
    )
      throw new Error("APK changed while snapshotting");
    receipt.original.identity = parseApkIdentity(
      await run("original identity", aapt, ["dump", "badging", original]),
    );
    receipt.candidate.identity = parseApkIdentity(
      await run("candidate identity", aapt, ["dump", "badging", candidate]),
    );
    if (
      JSON.stringify(receipt.original.identity) !==
      JSON.stringify(receipt.candidate.identity)
    )
      throw new Error(
        "Original and candidate APK package/version/activity identity differ",
      );

    const keyDirectory = join(
      homedir(),
      ".local",
      "share",
      "rea-personal",
      "android-signing",
    );
    await mkdir(keyDirectory, { recursive: true, mode: 0o700 });
    await chmod(keyDirectory, 0o700);
    const key = join(keyDirectory, "local-test.p12"),
      password = join(keyDirectory, "password");
    let keyExists = false;
    try {
      await readFile(key);
      keyExists = true;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!keyExists) {
      const lock = join(keyDirectory, "creation.lock");
      await writeFile(lock, randomUUID(), { flag: "wx", mode: 0o600 });
      try {
        // Keep an existing password after interrupted key generation; never replace it.
        try {
          await writeFile(password, randomBytes(32).toString("hex") + "\n", {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        await run("create dedicated test key", join(dirname(java), "keytool"), [
          "-genkeypair",
          "-keystore",
          key,
          "-storetype",
          "PKCS12",
          "-storepass:file",
          password,
          "-alias",
          "personal-rea-test",
          "-keyalg",
          "RSA",
          "-keysize",
          "3072",
          "-validity",
          "3650",
          "-dname",
          "CN=Personal REA Local Test,OU=Local Verification,O=Personal REA,C=KR",
          "-noprompt",
        ]);
        await chmod(key, 0o600);
      } finally {
        await unlink(lock);
      }
    }
    await readFile(password);
    await chmod(password, 0o600);
    await chmod(key, 0o600);
    const aligned = join(output, "candidate-aligned.apk"),
      signed = join(output, "candidate-signed.apk");
    await run("zipalign", zipalign, [
      "-P",
      "16",
      "-f",
      "4",
      candidate,
      aligned,
    ]);
    await run("sign", java, [
      "-jar",
      signerJar,
      "sign",
      "--ks",
      key,
      "--ks-key-alias",
      "personal-rea-test",
      "--ks-pass",
      `file:${password}`,
      "--out",
      signed,
      aligned,
    ]);
    const signature = await run("verify signature", java, [
      "-jar",
      signerJar,
      "verify",
      "--verbose",
      "--print-certs",
      signed,
    ]);
    await run("verify alignment", zipalign, ["-c", "-P", "16", "4", signed]);
    const digest = /Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/i.exec(
      signature,
    )?.[1];
    if (!digest) throw new Error("Verified signing certificate digest missing");
    receipt.signed = {
      path: signed,
      sha256: await fileDigest(signed),
      certificate_sha256: digest,
      key_scope: "dedicated-local-test",
    };
    receipt.signing = "verified";
    receipt.status = "signed";
    await save();
    if (!input.executeAcknowledged)
      return { ...receipt, receipt_path: receiptPath };
    if (
      !/^emulator-\d{4,5}$/.test(input.serial ?? "") ||
      !/^personal_rea_[A-Za-z0-9_-]+$/.test(input.avdName ?? "")
    )
      throw new Error(
        "Explicit dedicated Personal REA emulator serial and AVD name required",
      );
    const avdRoot = join(
      homedir(),
      ".local",
      "share",
      "rea-personal",
      "android-avd",
    );
    const ownership = JSON.parse(
      await readFile(join(avdRoot, `${input.avdName}.owner.json`), "utf8"),
    );
    if (
      ownership.schema_version !== 1 ||
      ownership.avd_name !== input.avdName ||
      ownership.purpose !== "personal-rea-dedicated-verification"
    )
      throw new Error("Dedicated AVD ownership receipt missing or invalid");
    const leasePath = join(avdRoot, `${input.avdName}.verification.lock`),
      leaseToken = randomUUID();
    await writeFile(
      leasePath,
      json({ token: leaseToken, receipt_path: receiptPath }),
      { flag: "wx", mode: 0o600 },
    );
    deviceLease = { path: leasePath, token: leaseToken };
    const adbRun = (name, args, timeout, cleanup) =>
      run(name, adb, ["-s", input.serial, ...args], timeout, cleanup);
    const devices = await run("connected devices", adb, ["devices"]);
    if (
      !devices
        .split(/\r?\n/)
        .some((line) => line.startsWith(`${input.serial}\t`))
    ) {
      const port = Number(input.serial.slice(9));
      if (port < 5554 || port > 5682 || port % 2)
        throw new Error("Dedicated emulator port must be even, 5554–5682");
      const emulatorSdk = join(
        homedir(),
        ".local",
        "share",
        "rea-personal",
        "tools",
        "android-sdk",
      );
      const emulator = join(emulatorSdk, "emulator", "emulator");
      for (const [root, version] of [
        [join(emulatorSdk, "emulator"), "37.2.12"],
        [
          join(
            emulatorSdk,
            "system-images",
            "android-35",
            "google_apis",
            "arm64-v8a",
          ),
          "9",
        ],
      ]) {
        const props = await readFile(join(root, "source.properties"), "utf8");
        if (
          !new RegExp(
            `^Pkg.Revision\\s*=\\s*${version.replaceAll(".", "\\.")}\\s*$`,
            "m",
          ).test(props)
        )
          throw new Error(
            `Dedicated emulator prerequisite version differs: ${version}`,
          );
      }
      await prepareOwnedCommand(signal);
      const launched = await spawnOwnedProviderProcess({
        command: emulator,
        arguments: [
          "-avd",
          input.avdName,
          "-port",
          String(port),
          "-no-window",
          "-no-audio",
          "-no-snapshot",
          "-no-boot-anim",
          "-gpu",
          "swiftshader",
          "-memory",
          "2048",
        ],
        cwd: output,
        runId: `rea-android-${randomUUID()}`,
        env: {
          ...process.env,
          ANDROID_AVD_HOME: avdRoot,
          ANDROID_HOME: emulatorSdk,
          ANDROID_SDK_ROOT: emulatorSdk,
        },
        signal,
      });
      emulatorOwner = new ProviderProcessSupervisor(
        { ...launched, ownsProcessLifetime: true },
        { maxDiagnosticBytes: 2 * 1024 * 1024 },
      );
      receipt.emulator = {
        started_by_job: true,
        executable: emulator,
        sha256: await fileDigest(emulator),
        version: "37.2.12",
        system_image: "android-35;google_apis;arm64-v8a;revision-9",
      };
      await save();
      const deadline = Date.now() + 180000;
      let booted = false;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (emulatorOwner.observedExit())
          throw new Error("Dedicated emulator exited during boot");
        const connected = await run("emulator connection", adb, ["devices"]);
        if (
          connected.split(/\r?\n/).includes(`${input.serial}\tdevice`) &&
          (
            await adbRun("boot status", [
              "shell",
              "getprop",
              "sys.boot_completed",
            ])
          ).trim() === "1"
        ) {
          booted = true;
          break;
        }
        await delay(1500, undefined, { signal });
      }
      if (!booted) throw new Error("Dedicated emulator boot timed out");
    }
    const name = (await adbRun("AVD identity", ["emu", "avd", "name"]))
      .trim()
      .split(/\r?\n/)[0];
    if (name !== input.avdName)
      throw new Error("Selected serial does not identify the owned AVD");
    if (
      (
        await adbRun("emulator check", ["shell", "getprop", "ro.kernel.qemu"])
      ).trim() !== "1"
    )
      throw new Error("Real devices are not supported by this workflow");
    receipt.device = {
      serial: input.serial,
      avd_name: name,
      ownership,
      fingerprint: (
        await adbRun("device fingerprint", [
          "shell",
          "getprop",
          "ro.build.fingerprint",
        ])
      ).trim(),
    };
    const pkg = receipt.original.identity.package,
      activity = receipt.original.identity.activity;
    if (!activity) throw new Error("APK has no launchable activity");
    const scenarios = validateAndroidScenarios(input.scenarios);
    const installed = (
      await adbRun("preexisting package check", [
        "shell",
        "pm",
        "list",
        "packages",
        pkg,
      ])
    ).split(/\r?\n/);
    if (installed.includes(`package:${pkg}`))
      throw new Error(
        "Target package already installed; refusing to replace existing app/data",
      );
    receipt.scenarios = scenarios;
    receipt.observations = {};
    receipt.status = "verifying";
    await save();
    const capture = async (label, apk, expectedHash) => {
      let installOwned = false,
        installAttempted = false;
      const remote = `/sdcard/rea-${randomUUID()}`;
      const assertInstalledIdentity = async () => {
        const paths = (
          await adbRun(
            `${label} installed path`,
            ["shell", "pm", "path", pkg],
            30000,
            true,
          )
        )
          .trim()
          .split(/\r?\n/);
        if (
          paths.length !== 1 ||
          !/^package:\/data\/app\/[A-Za-z0-9_./=+~-]+\/base.apk$/.test(paths[0])
        )
          throw new Error(
            "Installed APK identity unresolved; retaining cleanup ownership",
          );
        const hash = (
          await adbRun(
            `${label} installed hash`,
            ["shell", "sha256sum", paths[0].slice(8)],
            30000,
            true,
          )
        )
          .trim()
          .split(/\s+/)[0];
        if (hash !== expectedHash)
          throw new Error(
            "Installed APK no longer matches owned snapshot; refusing cleanup",
          );
      };
      try {
        installAttempted = true;
        const result = await adbRun(
          `${label} install`,
          ["install", "--no-streaming", apk],
          120000,
        );
        if (!/^Success\s*$/m.test(result))
          throw new Error(`${label} installation not confirmed`);
        installOwned = true;
        await assertInstalledIdentity();
        await adbRun(`${label} create capture directory`, [
          "shell",
          "mkdir",
          remote,
        ]);
        const launch = await adbRun(
          `${label} launch`,
          ["shell", "am", "start", "-W", "-n", `${pkg}/${activity}`],
          45000,
        );
        if (!/^Status: ok\s*$/m.test(launch))
          throw new Error(`${label} launch failed`);
        const observations = [];
        receipt.observations[label] = {
          installation: "verified",
          apk_sha256: expectedHash,
          launch,
          scenarios: observations,
        };
        for (const scenario of scenarios) {
          for (const tap of scenario.taps)
            await adbRun(`${label} tap`, [
              "shell",
              "input",
              "tap",
              String(tap.x),
              String(tap.y),
            ]);
          for (const keyName of scenario.keys)
            await adbRun(`${label} key`, [
              "shell",
              "input",
              "keyevent",
              `KEYCODE_${keyName}`,
            ]);
          await delay(scenario.waitMs, undefined, { signal });
          const pid = (
            await adbRun(`${label} pid`, ["shell", "pidof", pkg])
          ).trim();
          const foreground = await adbRun(`${label} foreground`, [
            "shell",
            "dumpsys",
            "activity",
            "activities",
          ]);
          const resumed = foreground
            .split(/\r?\n/)
            .filter((line) => /mResumedActivity|topResumedActivity/.test(line));
          if (
            !/^\d+(?: \d+)*$/.test(pid) ||
            !resumed.some((line) => line.includes(`${pkg}/`))
          )
            throw new Error(`${label} target is not running in foreground`);
          const stem = `${label}-${scenario.index}`;
          await adbRun(
            `${label} UI dump`,
            ["shell", "uiautomator", "dump", `${remote}/${stem}.xml`],
            45000,
          );
          await adbRun(`${label} UI pull`, [
            "pull",
            `${remote}/${stem}.xml`,
            join(output, `${stem}.xml`),
          ]);
          await adbRun(`${label} screenshot`, [
            "shell",
            "screencap",
            "-p",
            `${remote}/${stem}.png`,
          ]);
          await adbRun(`${label} screenshot pull`, [
            "pull",
            `${remote}/${stem}.png`,
            join(output, `${stem}.png`),
          ]);
          const logs = await adbRun(`${label} process logs`, [
            "logcat",
            "-d",
            "-v",
            "threadtime",
            "-t",
            "2000",
            `--pid=${pid.split(" ")[0]}`,
          ]);
          const crashes = await adbRun(`${label} crash logs`, [
            "logcat",
            "-d",
            "-b",
            "crash",
            "-v",
            "threadtime",
            "-t",
            "1000",
          ]);
          await writeFile(join(output, `${stem}.log`), logs);
          await writeFile(join(output, `${stem}-crash.log`), crashes);
          const hierarchy = normalizeAndroidHierarchy(
            await readFile(join(output, `${stem}.xml`), "utf8"),
            pkg,
          );
          observations.push({
            name: scenario.name,
            pid,
            resumed,
            hierarchy,
            screenshot: {
              path: join(output, `${stem}.png`),
              sha256: await fileDigest(join(output, `${stem}.png`)),
            },
            ui_path: join(output, `${stem}.xml`),
            log_path: join(output, `${stem}.log`),
            crash_log_path: join(output, `${stem}-crash.log`),
            process_fatal_exception: /FATAL EXCEPTION|Fatal signal/.test(logs),
          });
          await save();
        }
      } finally {
        // Cleanup deliberately ignores caller cancellation but re-proves APK identity.
        try {
          if (installAttempted && !installOwned) {
            const packages = await adbRun(
              `${label} cancelled install check`,
              ["shell", "pm", "list", "packages", pkg],
              30000,
              true,
            );
            if (packages.split(/\r?\n/).includes(`package:${pkg}`)) {
              await assertInstalledIdentity();
              installOwned = true;
            } else if (
              !receipt.commands.some(
                (command) =>
                  command.name === `${label} install` &&
                  Number.isInteger(command.exitCode),
              )
            ) {
              // Killing the local adb client does not prove its device-side install ended.
              throw new Error(
                "Installation completion is unknown after interruption; retaining package cleanup receipt",
              );
            }
          }
          if (installOwned) {
            await assertInstalledIdentity();
            await adbRun(
              `${label} force stop`,
              ["shell", "am", "force-stop", pkg],
              30000,
              true,
            );
            const result = await adbRun(
              `${label} uninstall`,
              ["uninstall", pkg],
              60000,
              true,
            );
            if (!/^Success\s*$/m.test(result))
              throw new Error("Uninstall not confirmed");
          }
          await adbRun(
            `${label} remove capture files`,
            ["shell", "rm", "-rf", remote],
            30000,
            true,
          );
          receipt.cleanup.push({
            label,
            status: "complete",
            installed_by_job: installOwned,
          });
        } catch (error) {
          receipt.cleanup.push({
            label,
            status: "unresolved",
            error: error.message,
            serial: input.serial,
            package: pkg,
            expected_sha256: expectedHash,
            remote,
          });
          await save();
          throw error;
        }
        await save();
      }
    };
    await capture("original", original, receipt.original.sha256);
    await capture("candidate", signed, receipt.signed.sha256);
    receipt.comparison = receipt.observations.original.scenarios.map(
      (left, i) => {
        const right = receipt.observations.candidate.scenarios[i];
        return {
          name: left.name,
          hierarchy_equal:
            JSON.stringify(left.hierarchy) === JSON.stringify(right.hierarchy),
          screenshot_equal: left.screenshot.sha256 === right.screenshot.sha256,
          both_foreground: true,
          fatal_exception_observed:
            left.process_fatal_exception || right.process_fatal_exception,
        };
      },
    );
    receipt.behavior = receipt.comparison.every(
      (c) => c.hierarchy_equal && !c.fatal_exception_observed,
    )
      ? "selected-scenarios-equal"
      : "selected-scenarios-different";
    receipt.status =
      receipt.behavior === "selected-scenarios-equal"
        ? "verified"
        : "behavior-mismatch";
    return { ...receipt, receipt_path: receiptPath };
  } catch (error) {
    receipt.status = signal?.aborted ? "cancelled" : "failed";
    receipt.error = error.message;
    error.receipt_path = receiptPath;
    throw error;
  } finally {
    if (emulatorOwner) {
      const stopped = await emulatorOwner.stop();
      receipt.emulator.stop = stopped;
      receipt.emulator.diagnostics = emulatorOwner.snapshot();
      if (stopped.status === "incomplete") {
        pendingEmulatorCleanup.add(emulatorOwner);
        receipt.status = "cleanup-unresolved";
        receipt.error = "Dedicated emulator cleanup unresolved";
        await save();
        throw new Error(`${receipt.error}; see ${receiptPath}`);
      }
    }
    if (deviceLease) {
      const current = JSON.parse(await readFile(deviceLease.path, "utf8"));
      if (current.token !== deviceLease.token) {
        receipt.status = "cleanup-unresolved";
        await save();
        throw new Error("Android device lease identity changed");
      }
      await unlink(deviceLease.path);
    }
    await save();
  }
}
