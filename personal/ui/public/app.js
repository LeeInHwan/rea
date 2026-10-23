const $ = (id) => document.getElementById(id);
const names = {
  analysis: "원본 분석",
  resume: "원본 재검사",
  recovery: "소스 복원 · 빌드",
  verification: "실행 비교",
  original: "원본 실행 수집",
  candidate: "후보 실행 수집",
  export: "증거 내보내기",
};
const statuses = {
  running: "진행 중",
  cancelling: "취소 · 정리 중",
  cancelled: "취소됨",
  complete: "작업 완료",
  failed: "실패",
  interrupted: "중단됨",
};
let config,
  currentJob,
  resultTab = "summary",
  pollTimer,
  browseField,
  selectedPath;
const formIds = [
  "target",
  "project",
  "assembly",
  "output",
  "original",
  "candidate",
  "original-args",
  "candidate-args",
  "cwd",
  "timeout",
  "ilspy",
  "dotnet",
];
async function api(path, data) {
  const response = await fetch(
    path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-REA-Request": "1" },
          body: JSON.stringify(data),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  setTimeout(() => {
    $("toast").hidden = true;
  }, 6000);
}
function remember() {
  localStorage.setItem(
    "rea-ui-form",
    JSON.stringify(Object.fromEntries(formIds.map((id) => [id, $(id).value]))),
  );
}
function updateTarget() {
  const path = $("target").value;
  $("target-label").textContent = path
    ? path.split(/[\\/]/).filter(Boolean).pop()
    : "파일 또는 폴더 선택";
}
function updateTools() {
  $("tool-summary").textContent =
    $("ilspy").value && $("dotnet").value
      ? "ILSpy · .NET SDK 경로 지정됨 · 실행 시 버전 검사"
      : "복원하려면 도구 설정에서 ILSpy와 .NET SDK 경로를 지정하세요.";
}
function args(id) {
  const value = JSON.parse($(id).value || "[]");
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
    throw new Error(
      '실행 인자는 문자열 JSON 배열이어야 합니다. 예: ["/path/App.dll", "42"]',
    );
  return value;
}
function inputFor(action) {
  const input = { action, project: $("project").value.trim() };
  if (["analyze", "pipeline"].includes(action))
    input.target = $("target").value.trim();
  if (["restore", "pipeline"].includes(action))
    Object.assign(input, {
      assembly: $("assembly").value.trim(),
      output: $("output").value.trim(),
      ilspy: $("ilspy").value.trim(),
      dotnet: $("dotnet").value.trim(),
    });
  if (["verify", "pipeline"].includes(action))
    Object.assign(input, {
      original: {
        executable: $("original").value.trim(),
        arguments: args("original-args"),
      },
      candidate: {
        executable: $("candidate").value.trim(),
        arguments: args("candidate-args"),
      },
      cwd: $("cwd").value.trim(),
      timeout: Number($("timeout").value),
      executeAcknowledged: $("execute-ack").checked,
    });
  return input;
}
function setBusy(busy) {
  for (const id of ["analyze", "restore", "verify", "pipeline", "resume"])
    $(id).disabled =
      busy ||
      (config?.platform === "win32" && ["verify", "pipeline"].includes(id));
}
async function start(action) {
  try {
    remember();
    const job = await api("/api/jobs", inputFor(action));
    await showJob(job.id);
    await history();
  } catch (error) {
    toast(error.message);
  }
}
function addMetric(title, detail) {
  const box = document.createElement("div");
  box.className = "metric";
  box.textContent = title;
  const small = document.createElement("small");
  small.textContent = detail;
  box.append(small);
  $("result-summary").append(box);
}
function renderJob(job) {
  currentJob = job;
  $("empty-state").hidden = true;
  $("job-content").hidden = false;
  $("job-status").textContent = statuses[job.status] || job.status;
  $("job-status").className = `status ${job.status}`;
  $("job-title").textContent = job.input.target || job.input.project;
  $("timeline").replaceChildren();
  for (const event of job.events) {
    const row = document.createElement("div");
    row.className = "event";
    row.textContent = `${event.status === "complete" ? "✓" : "◌"} ${names[event.step] || event.step} · ${event.status === "complete" ? "완료" : event.status === "failed" ? "실패" : "실행 중"}`;
    const time = document.createElement("time");
    time.textContent = new Date(event.time).toLocaleTimeString("ko-KR");
    row.append(time);
    $("timeline").append(row);
  }
  for (const step of ["analysis", "recovery", "verification"]) {
    const last = job.events.filter((e) => e.step === step).at(-1);
    $("step-" + step).className = `step ${last?.status || ""}`;
  }
  const busy = ["running", "cancelling"].includes(job.status);
  setBusy(busy);
  $("cancel").hidden = !busy;
  $("cancel").disabled = job.status === "cancelling";
  $("job-error").hidden = !job.error;
  $("job-error").textContent = job.error || "";
  $("result-summary").replaceChildren();
  const r = job.result;
  if (r?.plan)
    addMetric("원본 정체성 보관됨", `SHA-256 ${r.plan.target.sha256}`);
  if (r?.recovery)
    addMetric(
      "C# 프로젝트 복원 · 빌드 완료",
      "실행 검증은 별도 단계입니다. 아래 실행 비교 결과를 확인하세요.",
    );
  if (r?.execution_observations) {
    const o = r.execution_observations;
    addMetric(
      o.output_equal === null
        ? "출력 관찰 불완전"
        : o.output_equal
          ? "수집된 출력 바이트 동일"
          : "출력 바이트 차이 발견",
      `종료 코드: 원본 ${o.original_exit.code} / 후보 ${o.candidate_exit.code} · 시간 정보는 아래 전체 비교에 보존`,
    );
  }
  if (r?.comparison_status) {
    const labels = {
      unchanged: "관찰된 차이 없음",
      changed: "차이 발견",
      unknown: "판정 불확실",
      truncated: "관찰 불완전",
      contradiction: "근거 충돌",
    };
    addMetric(
      labels[r.comparison_status] || r.comparison_status,
      "선택한 한 실행 사례의 터미널·종료·프로세스 관찰 비교이며, 앱 전체 동등성 판정이 아닙니다.",
    );
  }
  renderResult();
  $("receipt-path").textContent = `작업 기록: ${job.directory}`;
}
function renderResult() {
  if (!currentJob) return;
  const r = currentJob.result;
  $("result-json").textContent =
    resultTab === "raw"
      ? JSON.stringify(currentJob, null, 2)
      : r
        ? JSON.stringify(
            {
              project: r.plan?.target.path,
              revision: r.plan?.revision,
              rebuild: r.recovery?.status,
              output: r.rebuilt_directory,
              execution_observations: r.execution_observations,
              comparison: r.verification?.normalized_result,
              features: r.plan?.features,
            },
            null,
            2,
          )
        : "단계별 진행 상태를 수집하고 있습니다. 결과가 나오면 이곳에 표시됩니다.";
}
async function showJob(id) {
  clearTimeout(pollTimer);
  try {
    const job = await api(`/api/jobs/${id}`);
    renderJob(job);
    if (["running", "cancelling"].includes(job.status))
      pollTimer = setTimeout(() => showJob(id), 1200);
    else await history();
  } catch (error) {
    toast(error.message);
  }
}
async function history() {
  const jobs = await api("/api/jobs");
  $("history-list").replaceChildren();
  if (!jobs.length) {
    $("history-list").textContent = "아직 작업이 없습니다.";
    return;
  }
  for (const job of jobs) {
    const row = document.createElement("button");
    row.className = "history-item";
    const title = document.createElement("div");
    title.textContent = (job.input.target || job.input.project)
      .split(/[\\/]/)
      .filter(Boolean)
      .pop();
    const date = document.createElement("small");
    date.textContent = `${new Date(job.created).toLocaleString("ko-KR")} · ${job.input.action}`;
    title.append(date);
    const state = document.createElement("span");
    state.textContent = statuses[job.status] || job.status;
    row.append(title, state);
    row.addEventListener("click", () => {
      for (const [key, id] of Object.entries({
        project: "project",
        target: "target",
        assembly: "assembly",
        output: "output",
        ilspy: "ilspy",
        dotnet: "dotnet",
        cwd: "cwd",
      }))
        if (job.input[key]) $(id).value = job.input[key];
      for (const side of ["original", "candidate"])
        if (job.input[side]) {
          $(side).value = job.input[side].executable;
          $(side + "-args").value = JSON.stringify(job.input[side].arguments);
        }
      updateTarget();
      updateTools();
      showJob(job.id);
    });
    $("history-list").append(row);
  }
}
async function browse(path) {
  selectedPath = null;
  $("browser-select").disabled = true;
  try {
    const listing = await api(`/api/browse?path=${encodeURIComponent(path)}`);
    selectedPath = listing.path;
    $("browser-select").disabled = false;
    $("browser-path").value = listing.path;
    $("browser-error").hidden = true;
    $("browser-list").replaceChildren();
    $("browser-count").textContent =
      `${listing.entries.length}개 항목${listing.total > 500 ? " · 처음 500개만 표시" : ""}`;
    $("browser-up").onclick = () => browse(listing.parent);
    $("browser-select").textContent = "현재 폴더 선택";
    for (const entry of listing.entries) {
      const row = document.createElement("button");
      row.className = "browser-row";
      const icon = document.createElement("span");
      icon.textContent = entry.directory ? "▱" : "▤";
      const name = document.createElement("span");
      name.className = "entry-name";
      name.textContent = entry.name;
      const action = document.createElement("small");
      action.textContent = entry.directory
        ? "열기 →"
        : entry.symlink
          ? "링크"
          : "선택";
      row.append(icon, name, action);
      row.addEventListener("click", () => {
        if (entry.directory) {
          browse(entry.path);
          return;
        }
        for (const node of $("browser-list").children)
          node.classList.remove("selected");
        row.classList.add("selected");
        selectedPath = entry.path;
        $("browser-select").textContent = "선택한 파일 사용";
      });
      $("browser-list").append(row);
    }
  } catch (error) {
    $("browser-error").textContent = error.message;
    $("browser-error").hidden = false;
  }
}
async function openBrowser(field) {
  browseField = field;
  $("browser-dialog").showModal();
  await browse(config.home);
}
$("choose-target").onclick = () => openBrowser("target");
for (const button of document.querySelectorAll("[data-browse]"))
  button.onclick = () => openBrowser(button.dataset.browse);
$("browser-close").onclick = () => $("browser-dialog").close();
$("browser-go").onclick = () => browse($("browser-path").value);
$("browser-path").onkeydown = (e) => {
  if (e.key === "Enter") browse(e.target.value);
};
$("browser-select").onclick = () => {
  if (!selectedPath) return;
  $(browseField).value = selectedPath;
  updateTarget();
  updateTools();
  remember();
  $("browser-dialog").close();
};
for (const button of document.querySelectorAll("[data-location]"))
  button.onclick = () =>
    browse(
      {
        home: config.home,
        applications:
          config.platform === "darwin" ? "/Applications" : config.home,
        downloads: config.home + "/Downloads",
        projects: config.projects,
      }[button.dataset.location],
    );
$("tools-open").onclick = () => $("tools-dialog").showModal();
$("tools-close").onclick = () => $("tools-dialog").close();
$("tools-save").onclick = async () => {
  try {
    await api("/api/settings", {
      ilspy: $("ilspy").value,
      dotnet: $("dotnet").value,
    });
  } catch (error) {
    toast(error.message);
    return;
  }
  remember();
  updateTools();
  $("tools-dialog").close();
  toast("도구 경로를 저장했습니다.");
};
for (const action of ["analyze", "resume", "restore", "verify", "pipeline"])
  $(action).onclick = () => start(action);
$("cancel").onclick = async () => {
  try {
    await api("/api/cancel", { id: currentJob.id });
    await showJob(currentJob.id);
  } catch (e) {
    toast(e.message);
  }
};
$("refresh-history").onclick = () => history().catch((e) => toast(e.message));
for (const button of document.querySelectorAll("[data-result]"))
  button.onclick = () => {
    resultTab = button.dataset.result;
    for (const b of document.querySelectorAll("[data-result]"))
      b.classList.toggle("selected", b === button);
    renderResult();
  };
$("download").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(currentJob, null, 2)], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `rea-${currentJob.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
for (const id of formIds)
  $(id).addEventListener("change", () => {
    updateTarget();
    remember();
  });
async function init() {
  config = await api("/api/config");
  $("version").textContent = config.version;
  $("host").textContent =
    { darwin: "MAC", linux: "LINUX", win32: "WINDOWS" }[config.platform] ||
    config.platform;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  $("project").value = `${config.projects}/project-${stamp}`;
  $("output").value = `${config.projects}/recovery-${stamp}`;
  $("cwd").value = config.home;
  $("ilspy").value = config.settings.ilspy || "";
  $("dotnet").value = config.settings.dotnet || "";
  try {
    const saved = JSON.parse(localStorage.getItem("rea-ui-form") || "{}");
    for (const id of formIds) if (saved[id]) $(id).value = saved[id];
  } catch {
    /* Ignore corrupt browser preferences. */
  }
  updateTarget();
  updateTools();
  setBusy(false);
  if (config.platform === "win32")
    $("platform-note").textContent =
      "Windows 터미널 캡처 미지원 · 분석과 복원은 도구 준비 후 사용";
  await history();
  if (config.active) await showJob(config.active);
}
init().catch((error) => toast(error.message));

$("new-project").onclick = () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  $("project").value = `${config.projects}/project-${stamp}`;
  $("output").value = `${config.projects}/recovery-${stamp}`;
  remember();
  toast("새 프로젝트와 복원 결과 경로를 준비했습니다.");
};
$("prepare-execution").onclick = () => {
  if (!$("dotnet").value || !$("assembly").value || !$("output").value) {
    toast("먼저 .NET 도구, 어셈블리와 복원 폴더를 지정하세요.");
    return;
  }
  $("original").value = $("candidate").value = $("dotnet").value;
  $("original-args").value = JSON.stringify([$("assembly").value]);
  $("candidate-args").value = JSON.stringify([
    $("output").value + "/rebuilt/" + $("assembly").value.split(/[\\/]/).pop(),
  ]);
  remember();
  toast("실행 경로를 채웠습니다. 필요한 프로그램 인자를 배열에 추가하세요.");
};
