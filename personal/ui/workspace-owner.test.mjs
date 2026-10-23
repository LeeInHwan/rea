import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { owned } from "../workbench/managed-restore.mjs";

test("real owner exit permits recovery and only then marks its unfinished job interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-owner-exit-"));
  try {
    const source = `import {startServer} from ${JSON.stringify(new URL("./server.mjs", import.meta.url).href)};
const ui=await startServer({stateDir:process.argv[1],runner:()=>new Promise(()=>{})});
const response=await fetch(ui.url,{redirect:"manual"});
await fetch(ui.base+'/api/jobs',{method:'POST',headers:{Cookie:response.headers.get('set-cookie').split(';')[0],Origin:ui.base,'Content-Type':'application/json','X-REA-Request':'1'},body:JSON.stringify({action:'resume',project:process.argv[1]+'/project'})});
process.exit(17);`;
    const result = await owned(
      process.execPath,
      ["--input-type=module", "-e", source, root],
      root,
      30000,
    );
    assert.equal(result.exitCode, 17, result.stderr.text);
    const ids = await readdir(join(root, "jobs"));
    assert.equal(ids.length, 1);
    const ui = await startServer({ stateDir: root });
    try {
      const saved = JSON.parse(
        await readFile(join(root, "jobs", ids[0], "job.json"), "utf8"),
      );
      assert.equal(saved.status, "interrupted");
      assert.ok(
        (await readdir(root)).some((n) =>
          n.startsWith(".workspace-owner.exited-"),
        ),
      );
    } finally {
      await ui.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed and incomplete ownership are retained instead of reclaimed", async () => {
  for (const content of [
    null,
    "{",
    JSON.stringify({ schema_version: 1, pid: process.pid }),
  ]) {
    const root = await mkdtemp(join(tmpdir(), "rea-owner-unknown-"));
    try {
      await mkdir(join(root, ".workspace-owner"));
      if (content !== null)
        await writeFile(join(root, ".workspace-owner/owner.json"), content);
      await assert.rejects(startServer({ stateDir: root }), /소유권|불완전/);
      if (content !== null)
        assert.equal(
          await readFile(join(root, ".workspace-owner/owner.json"), "utf8"),
          content,
        );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("idle authenticated shutdown releases ownership for the next runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-handoff-"));
  let ui;
  try {
    ui = await startServer({ stateDir: root });
    const login = await fetch(ui.url, { redirect: "manual" });
    const response = await fetch(ui.base + "/api/shutdown", {
      method: "POST",
      headers: {
        Cookie: login.headers.get("set-cookie").split(";")[0],
        Origin: ui.base,
        "Content-Type": "application/json",
        "X-REA-Request": "1",
      },
      body: "{}",
    });
    assert.equal(response.status, 200);
    await ui.close();
    ui = null;
    const next = await startServer({ stateDir: root });
    await next.close();
  } finally {
    if (ui) await ui.close();
    await rm(root, { recursive: true, force: true });
  }
});
