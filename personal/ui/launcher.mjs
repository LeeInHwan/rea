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
async function retirePriorServer() {
  let prior;
  try {
    prior = JSON.parse(await readFile(connection, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const url = new URL(prior.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !new RegExp("^/session/[a-f0-9]{64}$").test(url.pathname)
  )
    throw new Error("기존 UI 연결을 확인할 수 없습니다.");
  let login;
  try {
    login = await fetch(prior.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    return;
  } // Workspace ownership still proves owner exit before recovery.
  if (login.status !== 303) return;
  if (prior.lifecycle !== 1)
    throw new Error(
      "이전 UI가 실행 중입니다. 기존 작업의 완료와 서버 종료를 확인한 뒤 다시 여세요.",
    );
  const response = await fetch(url.origin + "/api/shutdown", {
    method: "POST",
    headers: {
      Cookie: `rea_session=${url.pathname.slice(9)}`,
      Origin: url.origin,
      "Content-Type": "application/json",
      "X-REA-Request": "1",
    },
    body: "{}",
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 200)
    throw new Error("기존 REA 작업의 완료·정리를 기다린 뒤 다시 여세요.");
  for (let i = 0; i < 80; i++) {
    try {
      const value = await fetch(prior.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(500),
      });
      if (value.status !== 303) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "기존 UI 서버의 종료가 지연되어 새 서버를 시작하지 않았습니다.",
  );
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
    await retirePriorServer();
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
