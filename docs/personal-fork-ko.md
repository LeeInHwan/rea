# 개인 포크 사용 안내

이 포크는 빌드된 macOS 앱·DMG, Windows 설치 폴더·EXE·DLL, Android APK를
분석하는 작업에 초점을 둡니다. 원본 프로젝트의 라이선스와 출처는 유지합니다.

## 시작하기

로컬 설치에 등록된 `rea` 명령을 사용합니다. Codex에서는 REA MCP 서버를
불러온 새 세션에서 파일 경로와 궁금한 기능을 함께 전달하면 됩니다.

```sh
rea inspect-artifact '/Applications/Example.app' --json
rea inspect-artifact '/path/to/Example.dmg' --json
rea inspect-artifact '/path/to/Windows 설치 폴더' --json
rea inspect-android-package '/path/to/Example.apk' --json
```

Codex 요청 예시:

> `/Applications/Example.app`을 REA로 분석해 줘. 먼저 `inspect_artifact`의
> `input_path`로 구성 파일을 확인하고, 자동 업데이트 기능의 구현 경로와
> 근거를 찾아 줘. 확인된 사실과 추정, 아직 확인하지 못한 부분을 구분해 줘.

## 이 포크의 개선

- [Personal REA Workbench](personal-rea-workbench.md)는 프로젝트별 증거 저장·재개,
  기능 계약, 의존성 계획, 원본/후보 검증과 패키지 내보내기를 제공합니다.
  `rea-workbench` CLI 또는 `rea_workbench` MCP로 사용합니다.
- `inspect-artifact`에서 일반 설치 폴더와 앱 번들을 직접 검사합니다.
  번들의 실행 파일을 먼저 열지 않아도 됩니다.
- MCP `inspect_artifact`에 선택적 `input_path`를 추가했습니다.
  기존 네이티브 분석 세션을 바꾸지 않고 다른 경로를 검사할 수 있습니다.
- 실제 인벤토리에 따라 JavaScript, 네이티브 바이너리, PE 관리 코드, APK의
  후속 분석을 안내합니다. 모든 폴더를 JavaScript로 간주하지 않습니다.
- 압축 내부 파일은 추출 후 분석하도록 안내하고, 중복된 네이티브 분석 제안을
  합칩니다. 읽지 못한 파일과 코드 심볼릭 링크로 분석 대상을 단정하지 않습니다.
  원본의 앱 메타데이터 검사도 유지해 읽을 수 있는 plist 링크는 별도로 안내합니다.
- CLI와 MCP는 같은 인벤토리·증거 생성·정리 경로를 사용합니다.

## 분석 엔진

| 대상                         | 엔진 및 조건                                      |
| ---------------------------- | ------------------------------------------------- |
| 네이티브 Mach-O·PE·ELF       | Ghidra와 호환되는 전체 JDK                        |
| APK 매니페스트·클래스·메서드 | REA가 지원하는 `jadx-headless-mcp` JAR와 전체 JDK |
| JavaScript·Electron·ASAR     | REA의 정적 분석 기능                              |
| DMG 내부 파일 목록           | macOS의 읽기 전용 마운트                          |

`rea doctor --provider ghidra --json`으로 Ghidra 준비 상태를 확인합니다.
APK는 [Android 분석 안내](android-analysis.md)에 따라
`REA_JADX_MCP_JAR`를 설정합니다. macOS에서 Windows 파일을 정적으로 분석하는
것과 Windows에서 프로그램을 실행하며 검사하는 것은 별도의 검증입니다.

## 소스 업데이트

일상적인 업데이트는 [Workbench의 stable 업데이트 경로](personal-rea-workbench.md#공식-버전-자동-추종)를
사용합니다. 별도 작업 공간에서 개인 기능의 호환성 검사를 통과한 뒤 설치 런타임을
전환합니다. 수동 개발에서는 `.nvmrc`와 `package.json`의 Node/npm을 사용합니다.

```sh
git fetch upstream
# upstream 변경 검토 및 병합 후
npm ci
npm run build:cached
```

설치된 MCP는 `~/.local/share/rea-personal/current`의 검증된 빌드를 사용합니다.
개발 checkout을 빌드하는 것만으로 설치 런타임이 바뀌지는 않습니다. 등록된 환경
변수를 유지하고, 런타임 전환 후에는 MCP를 재연결하거나 새 세션을 시작합니다.

2026-10-23에 공식 배포판 6.7.0을 통합했습니다. 기존 경로 검사 기능을 유지하고,
공식 후속 커밋 `23f984b1a`의 Android 검증 스크립트 수정도 반영했습니다.
[외부 포크와 확장 도구 조사](fork-research-20261023.md)에 비교 근거와 도입 후보를
정리했습니다.
