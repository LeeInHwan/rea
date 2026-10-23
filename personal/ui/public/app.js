const $ = (id) => document.getElementById(id);
const names = {
  analysis: "원본 분석",
  deep: "정밀 분석",
  extract: "패키지 추출",
  apk: "APK 복원 · 재빌드",
  apk_sign: "APK 서명",
  apk_verify: "APK 서명 · 실행 비교",
  apk_pipeline: "APK 복원 · 서명 · 실행 비교",
  native_recover: "네이티브 소스 재구성 · 실행 비교",
  android: "Android 서명 · 기기 검증",
  native: "네이티브 소스 재구성 · 검증",
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
  "member",
  "route",
  "java",
  "apktool",
  "apk-candidate",
  "android-sdk",
  "serial",
  "avd-name",
  "android-scenarios",
  "native-input",
  "native-cases",
  "native-cwd",
  "native-attempts",
  "compiler",
  "codex",
];
const toolFields = {
  ilspy: "ilspy",
  dotnet: "dotnet",
  java: "java",
  apktool: "apktool",
  androidSdk: "android-sdk",
  serial: "serial",
  avdName: "avd-name",
  compiler: "compiler",
  codex: "codex",
};
const actions = [
  "analyze",
  "resume",
  "restore",
  "verify",
  "pipeline",
  "deep",
  "extract",
  "apk",
  "apk_sign",
  "apk_verify",
  "apk_pipeline",
  "native_recover",
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
  $("android-tool-summary").textContent = $("android-sdk").value
    ? `SDK 지정됨 · 기기 ${$("serial").value || "미지정"} · AVD ${$("avd-name").value || "미지정"}`
    : "Android SDK · Java · Apktool 경로와 테스트 기기를 지정하세요.";
  $("native-tool-summary").textContent =
    $("compiler").value && $("codex").value
      ? "컴파일러 · Codex 지정됨 · 모델 전송 및 실제 실행 선택 필요"
      : "컴파일러와 로그인된 Codex CLI의 경로를 지정하세요.";
}
function objectArray(id, label) {
  let value;
  try {
    value = JSON.parse($(id).value || "[]");
  } catch {
    throw new Error(`${label}: 올바른 JSON 배열을 입력하세요.`);
  }
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some(
      (entry) => !entry || typeof entry !== "object" || Array.isArray(entry),
    )
  )
    throw new Error(
      `${label}: 하나 이상의 사례를 JSON 객체 배열로 입력하세요.`,
    );
  return value;
}
function acknowledge(id, message) {
  if (!$(id).checked) {
    $(id).focus();
    throw new Error(message);
  }
  return true;
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
  if (["deep", "extract"].includes(action)) {
    if ($("member").value.trim()) input.assembly = $("member").value.trim();
    if (action === "deep") input.route = $("route").value;
  }
  if (["apk_sign", "apk_verify", "apk_pipeline"].includes(action)) {
    Object.assign(input, {
      androidSdk: $("android-sdk").value.trim(),
      java: $("java").value.trim(),
    });
    if (action !== "apk_pipeline")
      input.apkCandidate = $("apk-candidate").value.trim();
    if (action !== "apk_sign")
      Object.assign(input, {
        serial: $("serial").value.trim(),
        avdName: $("avd-name").value.trim(),
        androidScenarios: objectArray("android-scenarios", "기기 시나리오"),
        executeAcknowledged: acknowledge(
          "android-execute-ack",
          "APK 카드에서 테스트 기기 설치·실행 항목을 확인해 주세요.",
        ),
      });
  }
  if (action === "native_recover") {
    Object.assign(input, {
      output: $("output").value.trim(),
      compiler: $("compiler").value.trim(),
      codex: $("codex").value.trim(),
      nativeCases: objectArray("native-cases", "네이티브 실행 사례"),
      cwd: $("native-cwd").value.trim(),
      attempts: Number($("native-attempts").value),
      executeAcknowledged: acknowledge(
        "native-execute-ack",
        "네이티브 카드에서 프로그램 실행 항목을 확인해 주세요.",
      ),
      modelAcknowledged: acknowledge(
        "model-ack",
        "네이티브 카드에서 Codex 모델로 소스 전송 항목을 확인해 주세요.",
      ),
    });
    if ($("native-input").value.trim())
      input.assembly = $("native-input").value.trim();
  }
  if (["apk", "apk_pipeline"].includes(action))
    Object.assign(input, {
      output: $("output").value.trim(),
      java: $("java").value.trim(),
      apktool: $("apktool").value.trim(),
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
  for (const id of actions)
    $(id).disabled =
      busy ||
      (config?.platform === "win32" &&
        ["verify", "pipeline", "native_recover"].includes(id));
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
    const stages = {
      analysis: ["analysis", "resume", "deep"],
      recovery: ["recovery", "extract", "apk", "native"],
      verification: ["verification", "android", "native"],
    };
    const last = job.events.filter((e) => stages[step].includes(e.step)).at(-1);
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
  $("use-apk-result").hidden = !r?.apk?.rebuilt?.path;
  $("inventory").replaceChildren();
  if (r?.inventory) {
    const title = document.createElement("h3");
    title.textContent = `분석한 구성 요소 · ${r.inventory.displayed} / ${r.inventory.total}`;
    $("inventory").append(title);
    const list = document.createElement("div");
    list.className = "inventory-list";
    for (const entry of r.inventory.entries) {
      const row = document.createElement("div");
      row.className = "inventory-entry";
      const name = document.createElement("span");
      name.textContent = entry.path;
      name.title = entry.sha256 || "해시 미확인";
      const format = document.createElement("small");
      format.textContent = entry.format + " · " + entry.hash_status;
      row.append(name, format);
      list.append(row);
    }
    $("inventory").append(list);
  }
  if (r?.plan)
    addMetric("원본 정체성 보관됨", `SHA-256 ${r.plan.target.sha256}`);
  if (r?.extract)
    addMetric(
      "배포 파일 추출 완료",
      r.extract.normalized_result.output_root +
        " · 원본 소스 복원/빌드 판정 아님",
    );
  if (r?.deep)
    addMetric(
      "정밀 분석 기록 보관됨",
      r.deep.evidence_path + " · 정적 분석 범위",
    );
  if (r?.apk)
    addMetric(
      "APK 복원 · 재빌드 완료",
      r.apk.rebuilt.path +
        (r.android
          ? " · 서명·실행 결과는 아래에서 확인"
          : " · 미서명 · 기기 실행 미검증"),
    );
  if (r?.android) {
    const labels = {
      signed: "APK 테스트 서명 완료",
      verified: "Android 지정 사례 비교 통과",
      "behavior-mismatch": "Android 동작 차이 발견",
      "needs-review": "Android 검증 결과 확인 필요",
    };
    addMetric(
      labels[r.android.status] ||
        `Android 상태: ${r.android.status || "미확인"}`,
      r.android.receipt_path ||
        r.android.signed?.path ||
        "전체 결과에서 서명·기기 실행 근거를 확인하세요.",
    );
    if (r.android.status === "signed")
      addMetric(
        "기기 실행은 별도 단계",
        "테스트 서명 완료만으로 설치·실행 성공을 판정하지 않습니다.",
      );
  }
  if (r?.native) {
    const labels = {
      verified: "네이티브 지정 사례 비교 통과",
      "behavior-mismatch": "네이티브 동작 차이 발견",
      "build-failed": "재구성 소스 빌드 실패",
      "needs-review": "네이티브 결과 확인 필요",
    };
    addMetric(
      labels[r.native.status] ||
        `네이티브 상태: ${r.native.status || "미확인"}`,
      r.native.output_directory ||
        r.native.candidate ||
        "전체 결과에서 복원 근거를 확인하세요.",
    );
    if (r.native.coverage)
      addMetric(
        "함수 분석 범위",
        typeof r.native.coverage === "string"
          ? r.native.coverage
          : JSON.stringify(r.native.coverage),
      );
    addMetric(
      "비교 범위: 지정한 명령행 사례",
      "선택한 입력의 출력·종료 상태 비교입니다. 원본 소스 일치나 앱 전체 동등성 판정이 아닙니다.",
    );
  }
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
              deep: r.deep,
              extraction: r.extract,
              apk: r.apk,
              android: r.android,
              native: r.native,
              output: r.rebuilt_directory,
              inventory: r.inventory,
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
    date.textContent = `${new Date(job.created).toLocaleString("ko-KR")} · ${names[job.input.action] || job.input.action}`;
    title.append(date);
    const state = document.createElement("span");
    state.textContent = statuses[job.status] || job.status;
    row.append(title, state);
    row.addEventListener("click", () => {
      for (const [key, id] of Object.entries({
        project: "project",
        target: "target",
        output: "output",
        ilspy: "ilspy",
        dotnet: "dotnet",
        cwd: "cwd",
        route: "route",
        java: "java",
        apktool: "apktool",
        apkCandidate: "apk-candidate",
        androidSdk: "android-sdk",
        serial: "serial",
        avdName: "avd-name",
        compiler: "compiler",
        codex: "codex",
        attempts: "native-attempts",
      }))
        if (job.input[key]) $(id).value = job.input[key];
      if (["restore", "pipeline"].includes(job.input.action))
        $("assembly").value = job.input.assembly || "";
      $("member").value = ["deep", "extract"].includes(job.input.action)
        ? job.input.assembly || ""
        : "";
      if (job.input.action === "native_recover") {
        $("native-input").value = job.input.assembly || "";
        $("native-cwd").value = job.input.cwd || config.home;
      }
      if (job.input.nativeCases)
        $("native-cases").value = JSON.stringify(
          job.input.nativeCases,
          null,
          2,
        );
      if (job.input.androidScenarios)
        $("android-scenarios").value = JSON.stringify(
          job.input.androidScenarios,
          null,
          2,
        );
      for (const id of [
        "execute-ack",
        "android-execute-ack",
        "native-execute-ack",
        "model-ack",
      ])
        $(id).checked = false;
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
for (const button of document.querySelectorAll("[data-tools-open]"))
  button.onclick = () => $("tools-dialog").showModal();
$("tools-close").onclick = () => $("tools-dialog").close();
$("tools-save").onclick = async () => {
  try {
    await api(
      "/api/settings",
      Object.fromEntries(
        Object.entries(toolFields).map(([key, id]) => [
          key,
          $(id).value.trim(),
        ]),
      ),
    );
  } catch (error) {
    toast(error.message);
    return;
  }
  remember();
  updateTools();
  $("tools-dialog").close();
  toast("도구 경로를 저장했습니다.");
};
for (const action of actions) $(action).onclick = () => start(action);
$("cancel").onclick = async () => {
  try {
    await api("/api/cancel", { id: currentJob.id });
    await showJob(currentJob.id);
  } catch (e) {
    toast(e.message);
  }
};
$("use-apk-result").onclick = () => {
  const candidate = currentJob?.result?.apk?.rebuilt?.path;
  if (!candidate) return;
  $("apk-candidate").value = candidate;
  remember();
  $("apk-candidate").scrollIntoView({ behavior: "smooth", block: "center" });
  $("apk-candidate").focus({ preventScroll: true });
  toast(
    "복원된 APK를 선택했습니다. 서명 또는 기기 실행 비교를 이어서 진행하세요.",
  );
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
    updateTools();
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
  $("native-cwd").value = config.home;
  for (const [key, id] of Object.entries(toolFields))
    $(id).value = config.settings[key] || "";
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
  for (const id of [
    "execute-ack",
    "android-execute-ack",
    "native-execute-ack",
    "model-ack",
  ])
    $(id).checked = false;
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
