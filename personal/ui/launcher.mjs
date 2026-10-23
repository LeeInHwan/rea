#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const state =
  process.env.REA_UI_STATE || join(homedir(), ".local/share/rea-personal/ui");
const connection = join(state, "connection.json");
await mkdir(state, { recursive: true, mode: 0o700 });
async function existing() {
  try {
    const value = JSON.parse(await readFile(connection, "utf8"));
    if (value.runtime !== fileURLToPath(new URL("../../", import.meta.url)))
      return null;
    const url = new URL(value.url);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") return null;
    const response = await fetch(value.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(1500),
    });
    return response.status === 303 ? value.url : null;
  } catch {
    return null;
  }
}
async function ensureServer() {
  let url = await existing();
  if (url) return url;
  const lockPath = join(state, "launcher.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 250));
      url = await existing();
      if (url) return url;
    }
    throw new Error(
      `UI 시작 잠금이 남아 있습니다. 실행 상태를 확인하세요: ${lockPath}`,
    );
  }
  try {
    url = await existing();
    if (url) return url;
    const output = await open(join(state, "server.log"), "a", 0o600);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./server.mjs", import.meta.url))],
      {
        cwd: resolve(fileURLToPath(new URL("../../", import.meta.url))),
        env: { ...process.env, REA_UI_STATE: state },
        detached: true,
        stdio: ["ignore", output.fd, output.fd],
      },
    );
    let failure;
    child.on("error", (error) => {
      failure = error;
    });
    child.unref();
    await output.close();
    for (let i = 0; i < 80; i++) {
      if (failure) throw failure;
      await new Promise((r) => setTimeout(r, 250));
      url = await existing();
      if (url) return url;
    }
    throw new Error(
      `UI 서버가 시작되지 않았습니다. ${join(state, "server.log")} 확인`,
    );
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
const url = await ensureServer();
if (process.argv.includes("--no-open"))
  console.log(
    "Personal REA UI is running. Connection is stored in the private state directory.",
  );
else {
  const command =
    process.platform === "darwin"
      ? "/usr/bin/open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  const browser = spawn(command, [url], { stdio: "ignore" });
  browser.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
