#!/usr/bin/env node
// Install launchers only; build/qualification and runtime activation precede this step.
import { mkdir, writeFile, readFile, lstat, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
const home = homedir();
if (process.platform !== "darwin")
  throw new Error(
    "This app installer supports macOS. Run launcher.mjs directly on other supported hosts.",
  );
const current = join(home, ".local/share/rea-personal/current");
await lstat(join(current, "personal/ui/launcher.mjs"));
const state = join(home, ".local/share/rea-personal/ui");
await mkdir(state, { recursive: true, mode: 0o700 });
try {
  await lstat(join(state, "settings.json"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const settings = {};
  for (const [key, file] of Object.entries({
    dotnet: "dotnet-10.0.100/dotnet",
    ilspy: "ilspy-11.1.0.9782/ilspycmd",
  })) {
    const path = join(home, ".local/share/rea-personal/tools", file);
    try {
      if ((await lstat(path)).isFile()) settings[key] = path;
    } catch {
      /* Caller can configure tools later. */
    }
  }
  await writeFile(
    join(state, "settings.json"),
    JSON.stringify(settings, null, 2),
    { flag: "wx", mode: 0o600 },
  );
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const bin = join(home, ".local/bin");
await mkdir(bin, { recursive: true });
const wrapper = join(bin, "rea-ui");
const content = `#!/bin/sh\n# Personal REA UI launcher\nexport GHIDRA_INSTALL_DIR=${quote(process.env.GHIDRA_INSTALL_DIR || "/opt/homebrew/opt/ghidra/libexec")}\nexport JAVA_HOME=${quote(process.env.JAVA_HOME || "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home")}\nexport REA_JADX_MCP_JAR=${quote(process.env.REA_JADX_MCP_JAR || join(home, ".local/share/rea/tools/jadx-headless-mcp-0.7.1-all.jar"))}\nexport DOTNET_ROOT=${quote(process.env.DOTNET_ROOT || join(home, ".local/share/rea-personal/tools/dotnet-10.0.100"))}\nexport DOTNET_CLI_TELEMETRY_OPTOUT=1\nexport DOTNET_NOLOGO=1\nexport PATH=${quote(process.execPath.slice(0, process.execPath.lastIndexOf("/")))}:"$PATH"\nexec ${quote(process.execPath)} ${quote(join(current, "personal/ui/launcher.mjs"))} "$@"\n`;
try {
  const prior = await readFile(wrapper, "utf8");
  if (!prior.includes("# Personal REA UI launcher"))
    throw new Error(`Unmanaged launcher exists: ${wrapper}`);
  await copyFile(wrapper, `${wrapper}.backup`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await writeFile(wrapper, content, { mode: 0o755 });
if (process.platform === "darwin") {
  const app = join(home, "Applications/Personal REA.app");
  const contents = join(app, "Contents");
  try {
    const info = await readFile(join(contents, "Info.plist"), "utf8");
    if (!info.includes("local.personal-rea.studio"))
      throw new Error(`Unmanaged app exists: ${app}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      await lstat(app);
      throw new Error(`Incomplete app exists: ${app}`);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Personal REA</string><key>CFBundleIdentifier</key><string>local.personal-rea.studio</string><key>CFBundleExecutable</key><string>PersonalREA</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/></dict></plist>`,
  );
  await writeFile(
    join(contents, "MacOS/PersonalREA"),
    `#!/bin/sh\nexec ${quote(wrapper)} "$@"\n`,
    { mode: 0o755 },
  );
  console.log(`Installed: ${app}`);
}
console.log(`Installed: ${wrapper}`);
