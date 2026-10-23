import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  observeProcessStartIdentity,
  observeProcessStartIdentityExit,
} from "../../dist/process/ProcessOwnershipObservation.js";

// Every contender uses the short acquisition gate, including stale-owner recovery.
// A crash in the gate is retained for manual inspection instead of PID-only stealing.
async function gated(root, action) {
  const gate = join(root, ".workspace-owner.gate"),
    token = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(gate, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || attempt >= 39)
        throw new Error(
          `작업 공간 소유권 확인 중입니다. 잠금 기록을 확인하세요: ${gate}`,
          { cause: error },
        );
      await delay(50);
    }
  }
  const claim = join(gate, "claim.json");
  await writeFile(claim, JSON.stringify({ token }), { mode: 0o600 });
  let value, failure;
  try {
    value = await action();
  } catch (error) {
    failure = error;
  }
  try {
    if (JSON.parse(await readFile(claim, "utf8")).token !== token)
      throw new Error("소유권 확인 잠금이 변경되었습니다.");
    await rm(gate, { recursive: true });
  } catch (cleanup) {
    if (failure)
      throw new AggregateError(
        [failure, cleanup],
        "작업 실패와 소유권 잠금 정리 실패를 함께 보존합니다.",
      );
    throw cleanup;
  }
  if (failure) throw failure;
  return value;
}

async function rejectLiveLegacyServer(root) {
  let connection;
  try {
    connection = JSON.parse(
      await readFile(join(root, "connection.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("기존 UI 연결 기록을 확인할 수 없습니다.", {
      cause: error,
    });
  }
  if (!Number.isSafeInteger(connection.pid) || connection.pid <= 0)
    throw new Error("기존 UI 프로세스 정체성이 불명확합니다.");
  if (
    connection.lifecycle === 1 &&
    typeof connection.start_identity === "string"
  ) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const status = await observeProcessStartIdentityExit(
        connection.pid,
        connection.start_identity,
      );
      if (status === "exited") return;
      if (status === "unverified")
        throw new Error("기존 UI 서버의 종료 정체성을 확인할 수 없습니다.");
      await delay(50);
    }
    throw new Error("기존 UI 서버가 아직 종료 중입니다.");
  }
  // Legacy records have no start identity. A present/reused PID is not reclaimable.
  const observed = await observeProcessStartIdentity(connection.pid);
  if (observed !== undefined)
    throw new Error(
      "이전 UI 서버가 남아 있습니다. 실행 작업과 종료 상태를 확인한 뒤 다시 시작하세요.",
    );
}

export async function acquireWorkspace(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const root = await realpath(stateDir),
    directory = join(root, ".workspace-owner"),
    record = join(directory, "owner.json");
  const identity = await observeProcessStartIdentity(process.pid);
  if (identity?.state !== "readable")
    throw new Error("UI 서버의 프로세스 시작 정체성을 확인할 수 없습니다.");
  const owner = {
    schema_version: 1,
    token: randomUUID(),
    pid: process.pid,
    start_identity: identity.identity,
  };
  await gated(root, async () => {
    let previous;
    try {
      previous = JSON.parse(await readFile(record, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error(`작업 공간 소유권 기록을 확인하세요: ${record}`, {
          cause: error,
        });
      // A directory without a record is an interrupted acquisition, not free space.
      try {
        await realpath(directory);
        throw new Error(`불완전한 작업 공간 잠금이 남았습니다: ${directory}`);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      await rejectLiveLegacyServer(root);
    }
    if (previous) {
      if (
        previous.schema_version !== 1 ||
        !Number.isSafeInteger(previous.pid) ||
        previous.pid <= 0 ||
        typeof previous.start_identity !== "string" ||
        typeof previous.token !== "string"
      )
        throw new Error(`잘못된 작업 공간 소유권 기록: ${record}`);
      const state = await observeProcessStartIdentityExit(
        previous.pid,
        previous.start_identity,
      );
      if (state !== "exited")
        throw new Error(
          state === "present"
            ? "이 작업 공간의 UI 서버가 이미 실행 중입니다."
            : "기존 UI 서버의 종료를 확인하지 못했습니다.",
        );
      await rename(
        directory,
        join(root, `.workspace-owner.exited-${randomUUID()}`),
      );
    }
    await mkdir(directory, { mode: 0o700 });
    await writeFile(record, JSON.stringify(owner, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
  });
  let released = false;
  return {
    owner,
    async release() {
      if (released) return;
      await gated(root, async () => {
        const current = JSON.parse(await readFile(record, "utf8"));
        if (
          current.token !== owner.token ||
          current.start_identity !== owner.start_identity ||
          current.pid !== owner.pid
        )
          throw new Error("작업 공간 소유권이 바뀌어 잠금을 보존합니다.");
        await rm(directory, { recursive: true });
        released = true;
      });
    },
  };
}
