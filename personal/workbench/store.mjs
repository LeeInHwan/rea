import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  mkdtemp,
  realpath,
} from "node:fs/promises";
import {
  join,
  resolve,
  relative,
  isAbsolute,
  dirname,
  basename,
} from "node:path";
import { stateSchema } from "./contracts.mjs";
import { parseEvidenceBundle } from "./engine.mjs";

export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export async function load(project) {
  const head = (await readFile(join(project, "HEAD"), "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(head)) throw new Error("Invalid project HEAD");
  const bytes = await readFile(join(project, "revisions", `${head}.json`));
  if (sha256(bytes) !== head) throw new Error("Checkpoint digest mismatch");
  const snapshot = JSON.parse(bytes);
  return {
    state: stateSchema.parse(snapshot.state),
    bundle: parseEvidenceBundle(snapshot.bundle),
    head,
  };
}
export async function save(project, state, bundle) {
  const bytes = json({
    state: stateSchema.parse(state),
    bundle: parseEvidenceBundle(bundle),
  });
  const head = sha256(bytes);
  await mkdir(join(project, "revisions"), { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(project, "revisions", `${head}.json`), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const temporary = join(project, `.head-${randomUUID()}`);
  await writeFile(temporary, `${head}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, join(project, "HEAD"));
  return head;
}
export async function locked(project, action) {
  const lock = join(project, ".lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Project is locked; another operation or interrupted writer owns .lock. Inspect before manually removing it.",
      );
    throw error;
  }
  try {
    await writeFile(
      join(lock, "owner.json"),
      json({ pid: process.pid, started_at: new Date().toISOString() }),
      { mode: 0o600 },
    );
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
export async function temporary(project, action) {
  const directory = await mkdtemp(join(project, ".operation-"));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function assertOutsideTarget(
  project,
  target,
  prospective = false,
) {
  const source = await realpath(target);
  const destination = prospective
    ? join(await realpath(dirname(resolve(project))), basename(project))
    : await realpath(project);
  const rel = relative(source, destination);
  if (
    !rel ||
    (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      rel !== ".." &&
      !isAbsolute(rel))
  )
    throw new Error("Project/export directory must be outside the target");
  return { project: resolve(destination), target: source };
}
