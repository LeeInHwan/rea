import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const summary = (job) => {
  const { result: _result, ...rest } = job;
  return rest;
};
export async function createJobs(stateDir, runner) {
  const root = join(stateDir, "jobs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const jobs = new Map();
  let active = null,
    starting = null,
    closing = false;
  const save = (job) =>
    writeFile(join(root, job.id, "job.json"), JSON.stringify(job, null, 2), {
      mode: 0o600,
    });
  for (const id of (await readdir(root)).filter((x) =>
    /^[a-f0-9-]{36}$/.test(x),
  )) {
    try {
      const job = JSON.parse(
        await readFile(join(root, id, "job.json"), "utf8"),
      );
      if (["running", "cancelling"].includes(job.status)) {
        job.status = "interrupted";
        job.error =
          "서버가 종료되었습니다. 로그를 확인한 뒤 새 작업을 시작하세요.";
        await save(job);
      }
      jobs.set(id, job);
    } catch {
      /* Incomplete metadata is not a successful job. */
    }
  }
  async function perform(job, controller) {
    try {
      job.result = await runner(
        job.input,
        job.directory,
        async (step, status, value) => {
          if (value !== undefined) {
            job.result ??= {};
            job.result[step] = value;
          }
          job.events.push({ step, status, time: new Date().toISOString() });
          await save(job);
        },
        controller.signal,
      );
      job.status = controller.signal.aborted ? "cancelled" : "complete";
    } catch (error) {
      job.status = controller.signal.aborted ? "cancelled" : "failed";
      job.error = error.message;
      if (error.receipt_path) job.receipt_path = error.receipt_path;
    } finally {
      job.finished = new Date().toISOString();
      try {
        await save(job);
      } catch (error) {
        job.status = "failed";
        job.error = `기록 저장 실패: ${error.message}`;
      } finally {
        active = null;
      }
    }
  }
  async function admit(input) {
    const job = {
      id: randomUUID(),
      created: new Date().toISOString(),
      status: "running",
      input,
      events: [],
      result: null,
      error: null,
    };
    job.directory = join(root, job.id);
    await mkdir(job.directory, { mode: 0o700 });
    await save(job);
    jobs.set(job.id, job);
    const controller = new AbortController();
    active = { id: job.id, controller };
    active.task = perform(job, controller);
    return summary(job);
  }
  return {
    get active() {
      return active?.id ?? null;
    },
    get busy() {
      return Boolean(active || starting || closing);
    },
    list: () =>
      [...jobs.values()]
        .sort((a, b) => b.created.localeCompare(a.created))
        .slice(0, 50)
        .map(summary),
    get: (id) => jobs.get(id),
    submit(input) {
      if (active || starting || closing)
        throw new Error(
          "진행 중인 작업이 있습니다. 완료 또는 취소를 기다려 주세요.",
        );
      starting = admit(input).finally(() => {
        starting = null;
      });
      return starting;
    },
    cancel(id) {
      if (!active || active.id !== id)
        throw new Error("실행 중인 해당 작업이 없습니다.");
      jobs.get(id).status = "cancelling";
      active.controller.abort(new Error("사용자가 작업을 취소했습니다."));
    },
    async close() {
      closing = true;
      try {
        await starting;
      } catch {
        /* Admission errors are returned to their caller. */
      }
      active?.controller.abort();
      await active?.task;
    },
  };
}
