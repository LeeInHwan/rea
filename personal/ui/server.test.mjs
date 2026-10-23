import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { executionObservations } from "./operations.mjs";

test("output summary excludes timing explicitly and never equates truncated output", () => {
  const capture = (data, time, truncated = false) => ({
    normalized_result: {
      frames: [{ data, at_ms: time }],
      exit: { code: 0, reason: "exited" },
      truncated,
    },
  });
  assert.equal(
    executionObservations(capture("42", 10), capture("42", 20)).output_equal,
    true,
  );
  assert.equal(
    executionObservations(capture("42", 10), capture("43", 20)).output_equal,
    false,
  );
  assert.equal(
    executionObservations(capture("42", 10, true), capture("42", 20))
      .output_equal,
    null,
  );
});

async function session(options, action) {
  const root = await mkdtemp(join(tmpdir(), "rea-ui-test-"));
  const ui = await startServer({ stateDir: join(root, "state"), ...options });
  try {
    const login = await fetch(ui.url, { redirect: "manual" });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const request = (path, data) =>
      fetch(ui.base + path, {
        headers: {
          Cookie: cookie,
          Origin: ui.base,
          "Content-Type": "application/json",
          "X-REA-Request": "1",
        },
        ...(data === undefined
          ? {}
          : { method: "POST", body: JSON.stringify(data) }),
      });
    await action({ root, ui, request, cookie });
  } finally {
    await ui.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function finish(request, id) {
  for (let count = 0; count < 600; count++) {
    const job = await (await request(`/api/jobs/${id}`)).json();
    if (!["running", "cancelling"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Job did not finish");
}
test("loopback UI denies anonymous access, foreign origins and unconfirmed execution", async () => {
  await session({}, async ({ ui, request, cookie }) => {
    assert.equal((await fetch(ui.base + "/api/config")).status, 401);
    assert.equal(
      (
        await fetch(ui.base + "/api/config", {
          headers: { Cookie: cookie, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(ui.base + "/api/jobs", {
          method: "POST",
          headers: { Cookie: cookie },
          body: "{}",
        })
      ).status,
      403,
    );
    const config = await (await request("/api/config")).json();
    assert.equal(config.platform, process.platform);
    assert.equal(
      (
        await request("/api/jobs", {
          action: "verify",
          project: "/tmp/p",
          executeAcknowledged: false,
        })
      ).status,
      400,
    );
    assert.equal((await request("/../package.json")).status, 404);
    assert.equal(
      (await request("/")).headers
        .get("content-security-policy")
        .includes("frame-ancestors 'none'"),
      true,
    );
  });
});
test("real HTTP analysis creates canonical project; resume, duplicate refusal and history", async () => {
  await session({}, async ({ root, request }) => {
    const target = join(root, "sample");
    await mkdir(target);
    await writeFile(join(target, "hello.txt"), "REA UI fixture");
    const project = join(root, "project");
    const started = await (
      await request("/api/jobs", { action: "analyze", target, project })
    ).json();
    const job = await finish(request, started.id);
    assert.equal(job.status, "complete", job.error);
    assert.match(job.result.plan.target.sha256, /^[a-f0-9]{64}$/);
    const duplicate = await (
      await request("/api/jobs", { action: "analyze", target, project })
    ).json();
    assert.equal((await finish(request, duplicate.id)).status, "failed");
    const resumed = await (
      await request("/api/jobs", { action: "resume", project })
    ).json();
    assert.equal((await finish(request, resumed.id)).status, "complete");
    assert.equal((await (await request("/api/jobs")).json()).length, 3);
  });
});
test("cancel reaches owned job signal and overlapping jobs are rejected", async () => {
  const runner = async (_input, _directory, progress, signal) => {
    await progress("verification", "running");
    await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  await session({ runner }, async ({ request, root }) => {
    const first = await (
      await request("/api/jobs", { action: "resume", project: root })
    ).json();
    assert.equal(
      (await request("/api/jobs", { action: "resume", project: root })).status,
      409,
    );
    assert.equal((await request("/api/cancel", { id: first.id })).status, 200);
    assert.equal((await finish(request, first.id)).status, "cancelled");
  });
});

test("simultaneous submissions admit exactly one job; settings persist", async () => {
  const runner = async (_input, _directory, _progress, signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  await session({ runner }, async ({ request, root }) => {
    const responses = await Promise.all([
      request("/api/jobs", { action: "resume", project: root }),
      request("/api/jobs", { action: "resume", project: root }),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409]);
    const job = await responses.find((r) => r.status === 202).json();
    await request("/api/cancel", { id: job.id });
    await finish(request, job.id);
    const settings = {
      ilspy: join(root, "ilspy"),
      dotnet: join(root, "dotnet"),
    };
    assert.equal((await request("/api/settings", settings)).status, 200);
    assert.deepEqual(
      (await (await request("/api/config")).json()).settings,
      settings,
    );
  });
});

test("artifact actions validate prerequisites and preserve package versus execution boundaries", async () => {
  const { requestSchema } = await import("./operations.mjs");
  assert.equal(
    requestSchema.safeParse({ action: "apk", project: "/p", output: "/o" })
      .success,
    false,
  );
  assert.equal(
    requestSchema.safeParse({ action: "deep", project: "/p" }).success,
    false,
  );
  assert.equal(
    requestSchema.parse({ action: "extract", project: "/p" })
      .executeAcknowledged,
    false,
  );
  await session({}, async ({ root, request }) => {
    const { createPackage } = await import("@electron/asar");
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      '{"name":"rea-owned-fixture","main":"index.js"}',
    );
    await writeFile(
      join(source, "index.js"),
      "module.exports = (a, b) => a + b;\n",
    );
    const target = join(root, "app.asar");
    await createPackage(source, target);
    const project = join(root, "project");
    const submit = async (input) => {
      const response = await request("/api/jobs", { project, ...input });
      assert.equal(response.status, 202);
      const job = await finish(request, (await response.json()).id);
      assert.equal(job.status, "complete", job.error);
      return job;
    };
    await submit({ action: "analyze", target });
    const extracted = await submit({ action: "extract" });
    const output = extracted.result.extract.normalized_result.output_root;
    try {
      const { readFile } = await import("node:fs/promises");
      assert.equal(
        await readFile(join(output, "index.js"), "utf8"),
        "module.exports = (a, b) => a + b;\n",
      );
      assert.ok(extracted.result.extract.evidence_path);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
    const inspected = await submit({ action: "deep", route: "javascript" });
    assert.ok(inspected.result.deep.evidence_id);
    assert.ok(inspected.result.deep.evidence_path);
    const { selectedArtifact } = await import("./artifact-workflows.mjs");
    await assert.rejects(
      () => selectedArtifact(project, join(source, "index.js")),
      /원본 내부/,
    );
    const folderProject = join(root, "folder-project");
    const { execute } = await import("../workbench/service.mjs");
    await execute("project_create", { project: folderProject, target: source });
    assert.equal(
      (await selectedArtifact(folderProject, join(source, "index.js"))).path,
      await realpath(join(source, "index.js")),
    );
    await writeFile(join(source, "index.js"), "changed");
    await assert.rejects(
      () => selectedArtifact(folderProject, join(source, "index.js")),
      /해시/,
    );
  });
});

test(
  "macOS DMG extraction uses real read-only mounts and retains detach provenance",
  { skip: process.platform !== "darwin" },
  async () => {
    await session({}, async ({ root, request }) => {
      const { owned } = await import("../workbench/managed-restore.mjs");
      const { readFile } = await import("node:fs/promises");
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "proof.txt"), "DMG proof\n");
      const image = join(root, "proof.dmg");
      const created = await owned(
        "/usr/bin/hdiutil",
        [
          "create",
          "-srcfolder",
          source,
          "-volname",
          "REA-fixture",
          "-format",
          "UDZO",
          image,
        ],
        root,
        120000,
      );
      assert.equal(created.exitCode, 0);
      const project = join(root, "project");
      for (const input of [
        { action: "analyze", target: image },
        { action: "extract" },
      ]) {
        const response = await request("/api/jobs", { project, ...input });
        assert.equal(response.status, 202);
        const job = await finish(request, (await response.json()).id);
        assert.equal(job.status, "complete", job.error);
        if (input.action === "extract") {
          const result = job.result.extract.normalized_result;
          try {
            const entry = result.artifacts.find((a) =>
              a.relative_path.endsWith("proof.txt"),
            );
            assert.ok(entry);
            assert.equal(
              await readFile(
                join(result.output_root, entry.relative_path),
                "utf8",
              ),
              "DMG proof\n",
            );
            assert.ok(
              result.provenance.some(
                (p) =>
                  p.arguments.includes("attach") &&
                  p.arguments.includes("-readonly"),
              ),
            );
            assert.ok(
              result.provenance.some((p) => p.arguments.includes("detach")),
            );
          } finally {
            await rm(result.output_root, { recursive: true, force: true });
          }
        }
      }
    });
  },
);
