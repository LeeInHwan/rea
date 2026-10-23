import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requestSchema, runOperation } from "./operations.mjs";
import { createJobs } from "./jobs.mjs";
import { VERSION } from "../workbench/contracts.mjs";
export const defaultStateDir = join(homedir(), ".local/share/rea-personal/ui");
const publicRoot = fileURLToPath(new URL("./public/", import.meta.url));
const equal = (a, b) =>
  typeof a === "string" &&
  /^[a-f0-9]{64}$/.test(a) &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error("요청이 너무 큽니다.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function secure(req, res, context, send) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  );
  if (req.headers.host !== new URL(context.base).host) {
    send(403, { error: "허용되지 않은 Host" });
    return false;
  }
  if (req.headers.origin && req.headers.origin !== context.base) {
    send(403, { error: "다른 사이트에서 접근할 수 없습니다." });
    return false;
  }
  const url = new URL(req.url, context.base);
  if (req.method === "GET" && url.pathname.startsWith("/session/")) {
    if (!equal(url.pathname.slice(9), context.secret))
      send(403, { error: "접속 키가 일치하지 않습니다." });
    else {
      res.writeHead(303, {
        Location: "/",
        "Set-Cookie": `rea_session=${context.secret}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end();
    }
    return false;
  }
  const cookie = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("rea_session="))
    ?.slice(12);
  if (!equal(cookie, context.secret)) {
    send(401, { error: "Personal REA 앱에서 다시 열어 주세요." });
    return false;
  }
  if (
    req.method === "POST" &&
    (req.headers["x-rea-request"] !== "1" ||
      req.headers.origin !== context.base ||
      !req.headers["content-type"]?.startsWith("application/json"))
  ) {
    send(403, { error: "요청 출처를 확인할 수 없습니다." });
    return false;
  }
  return url;
}
async function getRoute(url, context, send) {
  const { stateDir, projects, jobs, engineVersion } = context;
  if (["/", "/app.js", "/style.css", "/icon.svg"].includes(url.pathname)) {
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const types = {
      "index.html": "text/html",
      "app.js": "text/javascript",
      "style.css": "text/css",
      "icon.svg": "image/svg+xml",
    };
    return send(
      200,
      await readFile(join(publicRoot, name)),
      `${types[name]}; charset=utf-8`,
    );
  }
  if (url.pathname === "/api/config") {
    let settings = {};
    try {
      settings = JSON.parse(
        await readFile(join(stateDir, "settings.json"), "utf8"),
      );
    } catch {
      /* Fresh installation. */
    }
    return send(200, {
      version: VERSION,
      engine: engineVersion,
      platform: process.platform,
      home: homedir(),
      projects,
      settings,
      active: jobs.active,
    });
  }
  if (url.pathname === "/api/browse") {
    const directory = await realpath(url.searchParams.get("path") || homedir());
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith("."))
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      );
    return send(200, {
      path: directory,
      parent: dirname(directory),
      total: entries.length,
      entries: entries.slice(0, 500).map((e) => ({
        name: e.name,
        path: join(directory, e.name),
        directory: e.isDirectory(),
        symlink: e.isSymbolicLink(),
      })),
    });
  }
  if (url.pathname === "/api/jobs") return send(200, jobs.list());
  const match = /^\/api\/jobs\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (match && jobs.get(match[1])) return send(200, jobs.get(match[1]));
  return send(404, { error: "요청한 항목을 찾을 수 없습니다." });
}
async function postRoute(req, url, context, send) {
  const { stateDir, jobs } = context;
  if (url.pathname === "/api/jobs") {
    const input = requestSchema.parse(await body(req));
    if (
      ["verify", "pipeline"].includes(input.action) &&
      !input.executeAcknowledged
    )
      throw new Error("실행 확인을 선택하세요.");
    if (jobs.busy)
      return send(409, {
        error: "진행 중인 작업이 있습니다. 완료 또는 취소를 기다려 주세요.",
      });
    return send(202, await jobs.submit(input));
  }
  if (url.pathname === "/api/cancel") {
    const { id } = await body(req);
    if (jobs.active !== id)
      return send(409, { error: "실행 중인 해당 작업이 없습니다." });
    jobs.cancel(id);
    return send(200, { status: "cancelling" });
  }
  if (url.pathname === "/api/settings") {
    const value = await body(req);
    if (
      !value ||
      Object.keys(value).some((key) => !["ilspy", "dotnet"].includes(key))
    )
      throw new Error("지원하지 않는 설정입니다.");
    for (const key of ["ilspy", "dotnet"])
      if (
        typeof value[key] !== "string" ||
        (value[key] && !isAbsolute(value[key]))
      )
        throw new Error("도구의 절대 경로를 지정하세요.");
    await writeFile(
      join(stateDir, "settings.json"),
      JSON.stringify(value, null, 2),
      { mode: 0o600 },
    );
    return send(200, { saved: true });
  }
  return send(404, { error: "지원하지 않는 요청입니다." });
}
export async function startServer({
  port = 0,
  stateDir = defaultStateDir,
  runner = runOperation,
} = {}) {
  const projects = join(stateDir, "projects");
  await mkdir(projects, { recursive: true, mode: 0o700 });
  const jobs = await createJobs(stateDir, runner);
  const engineVersion = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ).version;
  const context = {
    base: null,
    secret: randomBytes(32).toString("hex"),
    stateDir,
    projects,
    jobs,
    engineVersion,
  };
  const server = http.createServer(async (req, res) => {
    const send = (code, data, type = "application/json; charset=utf-8") => {
      res.writeHead(code, { "Content-Type": type });
      res.end(
        type.startsWith("application/json") ? JSON.stringify(data) : data,
      );
    };
    try {
      const url = secure(req, res, context, send);
      if (!url) return;
      if (req.method === "GET") return await getRoute(url, context, send);
      if (req.method === "POST")
        return await postRoute(req, url, context, send);
      return send(405, { error: "지원하지 않는 요청 방식입니다." });
    } catch (error) {
      return send(400, { error: error.message });
    }
  });
  server.requestTimeout = 15000;
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  context.base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    base: context.base,
    url: `${context.base}/session/${context.secret}`,
    close: async () => {
      await jobs.close();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const stateDir = process.env.REA_UI_STATE || defaultStateDir;
  const ui = await startServer({
    port: Number(process.env.REA_UI_PORT || 0),
    stateDir,
  });
  await writeFile(
    join(stateDir, "connection.json"),
    JSON.stringify({
      url: ui.url,
      pid: process.pid,
      runtime: fileURLToPath(new URL("../../", import.meta.url)),
    }),
    { mode: 0o600 },
  );
  console.log(`Personal REA UI ready on ${ui.base}`);
  for (const sig of ["SIGTERM", "SIGINT"])
    process.once(sig, () => {
      void ui.close().then(() => process.exit(0));
    });
}
