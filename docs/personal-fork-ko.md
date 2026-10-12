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

- `inspect-artifact`에서 일반 설치 폴더와 앱 번들을 직접 검사합니다.
  번들의 실행 파일을 먼저 열지 않아도 됩니다.
- MCP `inspect_artifact`에 선택적 `input_path`를 추가했습니다.
  기존 네이티브 분석 세션을 바꾸지 않고 다른 경로를 검사할 수 있습니다.
- 실제 인벤토리에 따라 JavaScript, 네이티브 바이너리, PE 관리 코드, APK의
  후속 분석을 안내합니다. 모든 폴더를 JavaScript로 간주하지 않습니다.
- 압축 내부 파일은 추출 후 분석하도록 안내하고, 중복된 네이티브 분석 제안을
  합칩니다. 읽지 못한 파일과 심볼릭 링크로 분석 대상을 단정하지 않습니다.
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

포크에서 변경한 기능을 유지하려면 npm 배포판으로 덮어쓰지 말고 이 체크아웃을
빌드합니다. `.nvmrc`와 `package.json`에 지정된 Node/npm 버전을 사용합니다.

```sh
git fetch upstream
# upstream 변경 검토 및 병합 후
npm ci
npm run build:cached
```

MCP는 이 로컬 빌드를 사용하도록 등록되어야 합니다. 등록된 명령과 환경 변수를
유지하고, 빌드 또는 스킬 갱신 후에는 연결한 에이전트를 재시작합니다.
