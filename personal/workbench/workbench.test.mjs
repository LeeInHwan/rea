import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execute, plan } from "./service.mjs";
import { load, locked, sha256 } from "./store.mjs";

test("real REA: checkpoint, restore, structural acceptance, failures, packages and changed-original rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-workbench-test-"));
  try {
    const target = join(root, "original");
    const candidate = join(root, "candidate");
    const project = join(root, "project");
    await mkdir(target);
    await writeFile(join(target, "version.txt"), "fixture-v1\n");
    await cp(target, candidate, { recursive: true });
    await assert.rejects(
      execute("project_create", {
        project: join(target, "bad-project"),
        target,
      }),
      /outside/,
    );
    const initial = await execute("project_create", { project, target });
    assert.equal(initial.revision, 1);
    const feature = {
      id: "fixture",
      title: "Fixture inventory",
      description: "Compare retained original inventory",
      original_sha256: initial.target.sha256,
    };
    await execute("feature_define", { project, feature });
    await execute("artifact_compare", {
      project,
      feature_id: "fixture",
      candidate_path: candidate,
    });
    const verified = await execute("feature_verify", {
      project,
      feature_id: "fixture",
    });
    assert.equal(verified.features[0].verification, "pass");
    assert.equal(verified.features[0].status, "verified");
    assert.equal(
      verified.features[0].claim_scope[0].kind,
      "structural-artifact",
    );
    const resumed = await execute("project_resume", { project });
    assert.equal(resumed.features[0].status, "verified");
    const destination = join(root, "export");
    await execute("project_export", { project, destination });
    const manifest = JSON.parse(
      await readFile(join(destination, "manifest.json"), "utf8"),
    );
    for (const [name, digest] of Object.entries(manifest.files))
      assert.equal(sha256(await readFile(join(destination, name))), digest);
    await assert.rejects(
      execute("project_export", { project, destination }),
      /EEXIST/,
    );
    await execute("project_checkpoint", {
      project,
      bundle_path: join(destination, "evidence.json"),
    });
    assert.equal(
      (await execute("project_plan", { project })).features[0].verification,
      "not-run",
    );
    const bad = JSON.parse(
      await readFile(join(destination, "evidence.json"), "utf8"),
    );
    bad.records[0].operation = "forged";
    await writeFile(join(root, "bad.json"), JSON.stringify(bad));
    const before = (await load(project)).head;
    await assert.rejects(
      execute("project_checkpoint", {
        project,
        bundle_path: join(root, "bad.json"),
      }),
    );
    assert.equal((await load(project)).head, before);
    await writeFile(join(candidate, "version.txt"), "different\n");
    await execute("artifact_compare", {
      project,
      feature_id: "fixture",
      candidate_path: candidate,
    });
    assert.equal(
      (await execute("feature_verify", { project, feature_id: "fixture" }))
        .features[0].verification,
      "fail",
    );
    // A valid comparison cannot verify an unrelated original component.
    const checkpoint = await load(project);
    const component = checkpoint.bundle.records
      .find(
        (record) =>
          record.evidence_id === checkpoint.state.target.inventory_evidence_id,
      )
      .normalized_result.nodes.find(
        (node) => node.sha256 !== initial.target.sha256,
      );
    const passedContract = JSON.parse(
      await readFile(join(destination, "project.json"), "utf8"),
    ).features.fixture.contract;
    await execute("feature_define", {
      project,
      feature: {
        ...feature,
        id: "unbound",
        original_sha256: component.sha256,
        specification: passedContract.specification,
      },
    });
    const unbound = await execute("feature_verify", {
      project,
      feature_id: "unbound",
    });
    assert.equal(
      unbound.features.find((item) => item.id === "unbound").verification,
      "unknown",
    );
    await writeFile(join(target, "version.txt"), "updated original\n");
    const retained = (await load(project)).head;
    await assert.rejects(
      execute("project_resume", { project }),
      /Original target changed/,
    );
    assert.equal((await load(project)).head, retained);
    await locked(project, async () =>
      assert.rejects(execute("project_plan", { project }), /locked/),
    );
    const head = (await load(project)).head;
    await writeFile(join(project, "revisions", `${head}.json`), "corrupted");
    await assert.rejects(
      execute("project_plan", { project }),
      /digest mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency planner preserves missing inputs, cycles and transitive blocking", () => {
  const feature = (id, depends_on, status = "pass") => ({
    contract: { id, title: id, depends_on },
    verification: { status },
  });
  const state = {
    features: {
      base: feature("base", [], "unknown"),
      dependent: feature("dependent", ["base"]),
      top: feature("top", ["dependent"]),
      missing: feature("missing", ["absent"]),
      a: feature("a", ["b"]),
      b: feature("b", ["a"]),
      done: feature("done", []),
    },
  };
  const result = plan(state);
  assert.equal(
    result.features.find((item) => item.id === "done").status,
    "verified",
  );
  for (const id of ["dependent", "top", "missing", "a", "b"])
    assert.equal(
      result.features.find((item) => item.id === id).status,
      "blocked",
    );
  assert.deepEqual(
    result.features.find((item) => item.id === "missing").missing_dependencies,
    ["absent"],
  );
  assert.ok(
    result.cycles.some((cycle) => cycle.includes("a") && cycle.includes("b")),
  );
});

test("real workbench stdio MCP advertises validated schemas and preserves CLI parity", async () => {
  const client = new Client({ name: "workbench-contract-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("./cli.mjs", import.meta.url)), "mcp"],
        stderr: "inherit",
      }),
    );
    const { tools } = await client.listTools();
    assert.equal(tools.length, 8);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.inputSchema.required.includes("project"));
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    const invalid = await client.callTool({
      name: "project_plan",
      arguments: { project: 42 },
    });
    assert.equal(invalid.isError, true);
    const root = await mkdtemp(join(tmpdir(), "rea-workbench-mcp-"));
    try {
      const target = join(root, "target");
      await mkdir(target);
      await writeFile(join(target, "hello.txt"), "hello");
      const project = join(root, "project");
      const created = await client.callTool({
        name: "project_create",
        arguments: { project, target },
      });
      assert.notEqual(created.isError, true, JSON.stringify(created));
      const viaMcp = await client.callTool({
        name: "project_plan",
        arguments: { project },
      });
      const viaCli = JSON.parse(
        execFileSync(
          process.execPath,
          [
            fileURLToPath(new URL("./cli.mjs", import.meta.url)),
            "project_plan",
            JSON.stringify({ project }),
          ],
          { encoding: "utf8" },
        ),
      );
      assert.deepEqual(viaMcp.structuredContent, viaCli);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await client.close();
  }
});
