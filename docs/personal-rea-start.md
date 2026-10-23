# Personal REA 사용 설명서

**배포된 앱을 조사하고, 근거를 보관하며, 복원한 결과를 검증하는 도구입니다.**

[첫 화면](../README.md) · [전체 명령과 설계](personal-rea-workbench.md) · [분석 엔진 준비](personal-fork-ko.md)

> **화면으로 사용하기:** [Personal REA Local Studio](personal-rea-ui.md)에서 파일 선택·분석·복원·빌드·실행 비교를 진행할 수 있습니다.

## 1. 먼저 알아두기

Personal REA는 두 부분으로 구성됩니다.

| 구성      | 역할                                     | 소스 checkout에서 실행            |
| :-------- | :--------------------------------------- | :-------------------------------- |
| REA 엔진  | 파일·앱·바이너리 분석과 Evidence 생성    | `node scripts/rea.mjs`            |
| Workbench | 프로젝트 저장·재개, 기능 비교, .NET 복원 | `node personal/workbench/cli.mjs` |

이미 개인 런타임을 설치한 환경에서는 `rea`, `rea-workbench` 단축 명령도 사용할 수 있습니다.
**clone과 빌드만으로 단축 명령이나 MCP 연결이 자동 등록되지는 않습니다.**
공식 `npx rea-agents`만 실행하면 이 포크의 Workbench는 설치되지 않습니다.

## 2. 설치와 준비

### macOS / Linux 소스 설치

필수 버전은 `.nvmrc`의 Node.js **24.18.0**, `package.json`의 npm **11.16.0**입니다.
Linux에서 외부 분석 도구를 실행하려면 procps 호환 `ps`도 필요합니다.

```sh
git clone https://github.com/LeeInHwan/rea.git
cd rea
node --version
npm --version
npm ci
npm run build:cached
node scripts/rea.mjs --version
node personal/workbench/cli.mjs --version
```

Gitea에서 받는 경우에는 저장소 상단 **복제** 버튼의 URL로 첫 명령을 바꿉니다.
Workbench 버전은 `0.2.0`, 현재 엔진 버전은 `6.7.0`입니다.
버전이 다른 Node/npm을 자동 교체하지 않으므로 먼저 지정 버전을 준비하세요.

### 분석할 대상에 맞는 엔진

| 대상                                   | 준비 사항                                                          |
| :------------------------------------- | :----------------------------------------------------------------- |
| JavaScript / Electron / ASAR 정적 분석 | 기본 REA 빌드                                                      |
| Mach-O / PE / ELF 심층 분석            | 기존 Ghidra와 호환되는 전체 JDK 또는 지원되는 다른 native provider |
| APK 매니페스트·클래스·메서드 분석      | 지원되는 JADX headless MCP JAR와 전체 JDK                          |
| DMG 내부 목록 검사                     | macOS의 읽기 전용 마운트 경로                                      |
| .NET 앱 프로젝트 복원·빌드             | ILSpy **11.1.0.9782**, 호환 .NET SDK, 실행 파일의 절대 경로        |

엔진별 환경 변수와 진단 방법은 [아티팩트 분석 안내](personal-fork-ko.md)를 확인하세요.
Ghidra, Java, JADX는 이 설치 명령이 대신 설치하지 않습니다.

<a id="windows-setup"></a>

### Windows 소스 실행 준비

Windows의 파일·프로세스 소유권 검사에는 **현재 소스와 일치하는 Windows native bundle**이 필요합니다.
`npm ci`와 `build:cached`만으로 이 bundle이 만들어지지는 않습니다.

1. 현재 커밋으로 실행된 `Personal REA Windows Execution` workflow를 엽니다.
2. `personal-windows-native-and-fixtures` artifact를 받아 압축을 풉니다.
3. artifact의 `native/windows/build/`를 checkout의 같은 위치에 복사합니다.
4. 지정 Node/npm으로 `npm ci`, `npm run verify:windows-native:artifact`, `npm run build:cached`를 실행합니다.

동일 커밋의 artifact가 없으면 먼저 해당 workflow를 실행합니다. 직접 만드는 경로는
Linux + MinGW-w64의 `npm run build:windows-native`이며,
[Windows workflow](../.github/workflows/personal-windows.yml)에 실제 빌드·검증 순서가 있습니다.
기존 공식 엔진의 Windows 범위는 [Windows Ghidra 안내](windows-ghidra-p0.md)에서 확인할 수 있습니다.

## 3. 앱의 구성을 먼저 확인하기

macOS/Linux 터미널에서 실제 경로를 지정합니다.

```sh
node scripts/rea.mjs inspect-artifact '/Applications/Example.app' --json
node scripts/rea.mjs inspect-artifact '/path/to/Example.dmg' --json
node scripts/rea.mjs inspect-artifact '/path/to/Windows-install-folder' --json
node scripts/rea.mjs inspect-artifact '/path/to/Example.apk' --json
```

파일 형식과 내부 구성, 읽지 못한 부분, 다음에 사용할 분석 도구를 확인합니다.
`next_probes`는 **제안**입니다. 심층 분석을 이미 실행했다는 뜻은 아닙니다.
앱을 실제로 실행하는 검사와 파일만 읽는 정적 분석도 구분합니다.

## 4. 프로젝트 만들기 → 재개 → 공유

원본 폴더와 작업 폴더를 분리합니다. 아래 경로는 모두 실제 경로로 바꾸세요.

```sh
node personal/workbench/cli.mjs project_create '{"project":"/work/rea-project","target":"/apps/Example"}'
node personal/workbench/cli.mjs project_plan '{"project":"/work/rea-project"}'
node personal/workbench/cli.mjs project_resume '{"project":"/work/rea-project"}'
node personal/workbench/cli.mjs project_export '{"project":"/work/rea-project","destination":"/work/new-export"}'
```

- `project_create`: 원본의 구성과 해시를 고정하고 새 프로젝트를 만듭니다.
- `project_plan`: 저장된 기능·의존성·검증 상태를 보여줍니다. 새 프로젝트에는 아직 기능이 없습니다.
- `project_resume`: 원본이 그대로인지 재검사하고 증거를 복원합니다.
- `project_export`: 기능 계약·증거·상태와 SHA-256 manifest를 새 폴더로 내보냅니다.

내보낸 증거 패키지에 원본 앱이나 복원 소스가 자동으로 포함되는 것은 아닙니다.
복원 소스와 빌드 결과는 복원 명령에서 지정한 별도 출력 폴더에 있습니다.

**PowerShell에서는 JSON 파일 입력을 권장합니다.** 예를 들어 `create.json`을 UTF-8로 저장합니다.

```json
{
  "project": "C:/rea/project",
  "target": "C:/apps/Example"
}
```

```powershell
node personal/workbench/cli.mjs project_create '@create.json'
```

## 5. 원본과 후보 비교하기

먼저 기능을 등록합니다. `original_sha256`에는 프로젝트 생성 결과의 `target.sha256`를 넣습니다.
아래 내용을 `feature.json`으로 저장하고 경로와 해시를 실제 값으로 바꿉니다.

```json
{
  "project": "/work/rea-project",
  "feature": {
    "id": "package-layout",
    "title": "배포 파일 구성 비교",
    "description": "원본과 후보의 배포 구성이 일치하는지 확인한다.",
    "original_sha256": "REPLACE_WITH_TARGET_SHA256",
    "depends_on": []
  }
}
```

```sh
node personal/workbench/cli.mjs feature_define @feature.json
node personal/workbench/cli.mjs artifact_compare '{"project":"/work/rea-project","feature_id":"package-layout","candidate_path":"/apps/Example-candidate"}'
node personal/workbench/cli.mjs feature_verify '{"project":"/work/rea-project","feature_id":"package-layout"}'
```

이 예시는 **파일 구성에 대한 비교**입니다. 계산·화면·네트워크 동작이 같다는 검증은 별도입니다.
동작 검증은 실제 실행 증거와 선언한 비교 항목을 연결해야 합니다.

| 결과      | 읽는 방법                                                              |
| :-------- | :--------------------------------------------------------------------- |
| `pass`    | 선언한 비교 항목이 통과했습니다. 앱 전체의 동일성을 의미하지 않습니다. |
| `fail`    | 선언한 비교 항목에서 차이 또는 불일치를 확인했습니다.                  |
| `unknown` | 근거 부족이나 원본 연결 부족 등으로 판정할 수 없습니다.                |
| `not-run` | 아직 해당 검증을 실행하지 않았습니다.                                  |

## 6. .NET 앱을 C# 프로젝트로 복원하기

현재 지원하는 첫 경로는 **단일 .NET 실행 assembly와 내장 리소스**입니다.
원본 설치 폴더를 먼저 `project_create`로 등록한 후, 그 안의 실제 managed DLL/EXE를 선택합니다.
네이티브 apphost EXE 대신 관리 코드가 들어 있는 assembly를 지정하세요.

Windows native bundle과 .NET SDK를 준비한 다음, 필요한 경우 도구를 별도 폴더에 설치합니다.
ILSpy 11.1의 도구 설치에는 .NET SDK 10.0.100 이상이 필요하며, 대상 앱의 framework도 빌드·실행 가능해야 합니다.

```powershell
dotnet tool install ilspycmd --version 11.1.0.9782 --tool-path C:/tools/rea-ilspy
```

`restore.json`을 작성합니다.

```json
{
  "project": "C:/rea/project",
  "assembly_path": "C:/apps/Example/Example.dll",
  "output_directory": "C:/rea/new-recovery",
  "ilspy_command": "C:/tools/rea-ilspy/ilspycmd.exe",
  "dotnet_command": "C:/Program Files/dotnet/dotnet.exe",
  "timeout_ms": 300000
}
```

```powershell
node personal/workbench/cli.mjs restore_managed_application '@restore.json'
```

출력 폴더는 원본 밖의 **아직 존재하지 않는 경로**여야 합니다.

```text
new-recovery/
├── input/          복원에 사용한 assembly 사본
├── source/         복원한 C# 프로젝트와 리소스
├── rebuilt/        다시 빌드한 결과
├── recovery.json   상태·해시·도구·제한 사항
└── *.json          단계별 명령과 실행 로그
```

성공 응답은 `status: rebuilt`, `behavior: not-run`입니다.
대상 앱을 자동 실행하지 않습니다. 복원 이후에는 원본과 후보를 각각 실행하여
핵심 시나리오의 입력·출력·화면·저장 상태를 비교해야 합니다.
다중 application DLL, 외부 패키지, 임의 MSBuild 작업은 현재 복원 경로에서 거부합니다.

<a id="agent-use"></a>

## 7. AI 에이전트에서 사용하기

사용 중인 MCP 클라이언트에 아래 두 서버의 실행 명령을 등록합니다.
경로는 **빌드가 완료된 checkout의 절대 경로**로 지정하세요.
설정 파일 위치와 형식은 클라이언트마다 다릅니다.

| MCP 서버 이름   | 실행 파일                       | 인자                                              |
| :-------------- | :------------------------------ | :------------------------------------------------ |
| `rea`           | 실제 Node 실행 파일의 절대 경로 | `/absolute/rea/scripts/rea.mjs`, `mcp`            |
| `rea_workbench` | 실제 Node 실행 파일의 절대 경로 | `/absolute/rea/personal/workbench/cli.mjs`, `mcp` |

Ghidra·JADX를 사용한다면 해당 서버 환경에도 필요한 환경 변수를 전달합니다.
MCP 연결을 새로 열어 REA와 Workbench 도구가 표시되는지 확인하세요.
Workbench는 현재 **9개 도구**를 제공합니다.

**첫 조사 요청**

> 이 앱을 REA로 분석해 줘. 대상은 `/Applications/Example.app`이야.
> 먼저 구성 파일을 확인하고, 자동 업데이트 기능의 구현 경로를 조사해 줘.
> 확인된 사실·추정·아직 모르는 부분을 구분하고 근거를 남겨 줘.

**프로젝트 저장과 재개**

> 원본은 `/apps/Example`, 프로젝트는 `/work/rea-project`로 만들어 줘.
> 핵심 기능을 나누고 의존성과 검증 방법을 정리해 줘.
> 다음 작업 때 원본 변경 여부를 검사한 뒤 이 프로젝트를 이어서 진행해 줘.

**복원 요청**

> 등록된 원본의 `Example.dll`을 `restore_managed_application`으로 복원해 줘.
> 내가 준비한 ILSpy와 dotnet의 절대 경로를 사용하고 결과는 새 출력 폴더에 저장해 줘.
> 빌드 성공과 동작 검증을 구분하고, 아직 확인하지 않은 기능을 목록으로 남겨 줘.

## 8. 자주 만나는 상황

| 상황                                   | 다음 조치                                                                   |
| :------------------------------------- | :-------------------------------------------------------------------------- |
| `rea-workbench` 명령을 찾지 못함       | 소스 checkout에서 `node personal/workbench/cli.mjs`를 사용합니다.           |
| `dist` 모듈을 찾지 못함                | 지정 버전으로 `npm ci`, `npm run build:cached`를 실행합니다.                |
| 원본이 변경됐다는 오류                 | 새 원본용 프로젝트를 만듭니다. 과거 해시를 새 파일에 재사용하지 않습니다.   |
| 출력 폴더가 이미 존재함                | 새 경로를 지정합니다. 실패 로그가 있는 기존 폴더는 확인 후 정리합니다.      |
| 프로젝트가 잠겨 있음                   | 다른 실행이 끝났는지 확인합니다. `.lock`을 임의로 제거하지 않습니다.        |
| Ghidra/JADX 준비 실패                  | [엔진 준비 안내](personal-fork-ko.md)와 해당 provider 진단을 확인합니다.    |
| Windows native bundle 오류             | 동일 소스의 bundle을 준비하고 artifact 검사를 실행합니다.                   |
| 복원은 성공했지만 실행은 확인되지 않음 | `rebuilt`와 `not-run`은 정상적인 구분입니다. 동작 비교를 별도로 수행합니다. |

## 9. 업데이트와 검증 기록

공식 stable 업데이트는 [Workbench 업데이트 절차](personal-rea-workbench.md#공식-버전-자동-추종)를 따릅니다.
자동 적용 스크립트는 소유자의 Mac 개인 포크 환경을 전제로 합니다.
Gitea clone에 같은 설정이 자동으로 생기는 것은 아니며, GitHub 자동 push와 Gitea 동기화도 별개입니다.

- [실제 Windows 실행·복원 검증](https://github.com/LeeInHwan/rea/actions/runs/39846750693)
- [Linux/macOS Workbench 검증](https://github.com/LeeInHwan/rea/actions/runs/39844921501)
- [재현 가능한 Windows workflow](../.github/workflows/personal-windows.yml)

Windows 참조 앱에서는 11개 UI 사례와 변경된 계산의 실패 감지를 확인했습니다.
이 결과는 임의의 상용 앱·드라이버·APK 전체 복원을 보장하지 않습니다.
원본 출처와 MIT 라이선스는 [공식 REA](https://github.com/morluto/rea)와 [LICENSE](../LICENSE)를 확인하세요.
