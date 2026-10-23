# 형식별 복원 범위와 검증

2026-10-23 공식 문서와 실제 로컬 실행을 기준으로 정리했습니다.
설치 파일에서 모든 소스를 원래대로 되돌리고 모든 기능이 동일한 앱을 자동 생성하는 범용 도구는 확인하지 못했습니다.
그러나 형식별로 실용적인 복원 경로가 있어 Personal Studio에 연결했습니다.

| 대상              | 현재 연결한 경로                                                  | 보장하지 않는 범위                                               |
| ----------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| DMG               | 읽기 전용 마운트 → 일반 파일 추출 → 내부 앱을 새 프로젝트로 분석  | DMG 자체는 소스 언어가 아니며 내부 앱 전체 재구현을 뜻하지 않음  |
| Electron / ASAR   | 배포 JS·리소스 추출, 모듈 그래프 분석                             | 원래 TypeScript·빌드 설정·외부 서버·별도 네이티브 모듈 복원      |
| APK               | JADX 정적 분석 + Apktool Smali·리소스 decode/build                | 원본 Java/Kotlin 전체, Gradle 프로젝트, 서명·설치·기기 동작 검증 |
| Mach-O / PE / ELF | Ghidra 바이너리·함수 개요, 기존 REA MCP의 함수 디컴파일·호출 분석 | ABI·의존성·리소스를 포함한 임의 앱 전체의 자동 재빌드            |
| .NET              | 기존 ILSpy 단일 어셈블리 프로젝트 복원·재빌드와 실행 비교         | 임의 외부 의존성·모든 GUI 시나리오의 자동 동등성 판정            |

## 조사한 확장 도구

- [RE-Agent](https://github.com/heaven-hm/re-agent/blob/a84c61e8baa65d445485722420a57ff4132b90d3/README.md):
  체크포인트·네이티브/실행 근거·재구현 워크플로. 임의 앱 자동 재생성과 프로그램 전체 동등성을 명시적으로 보장하지 않습니다.
- [RECarve 0.44.0](https://github.com/LuckyFishOno/reverse-engineering-carve/releases/tag/v0.44.0):
  기능 계약과 사례별 검증을 관리하는 companion MCP. native/mobile은 실험 단계이고 에뮬레이션 검증은 실제 Windows 앱 실행 검증과 다릅니다.
- [Dryxio/ReAgent 0.4.0](https://github.com/Dryxio/reagent/blob/d12cea338c61898b06a86fe8adb25275fa9d5615/README.md):
  Ghidra와 LLM을 이용한 C/C++ 함수 후보 복구 및 설정된 빌드·테스트 검사. 함수 단위 확장 후보이며 현재 Studio에 통합하거나 전체 앱 복원으로 검증한 상태는 아닙니다.
- [JADX](https://github.com/skylot/jadx): DEX/APK를 Java로 디컴파일합니다. 공식 안내에도 완전한 디컴파일이 어려운 경우가 있음을 명시합니다.
- [Apktool](https://github.com/iBotPeaches/Apktool): 리소스·Smali 프로젝트를 다시 APK로 빌드할 수 있습니다. 공식 3.0.3 릴리스 JAR과 공개 SHA-256을 고정했습니다.
- [Electron ASAR](https://www.electronjs.org/docs/latest/tutorial/asar-archives): ASAR는 배포된 파일을 보관하는 아카이브입니다. 추출한 JS는 원래 개발 소스와 다를 수 있습니다.

## 검증 방법

`personal/ui/artifact-proof.mjs`는 도구 경로를 명시한 환경에서 실제 APK decode/build와 JADX 분석,
ASAR 추출/JS 분석, macOS 자체 생성 DMG 추출과 자체 컴파일 Mach-O의 Ghidra 분석을 수행합니다.
기본 APK 재빌드는 미서명 상태로 남깁니다. 추가한 [서명·전용 에뮬레이터 검증](personal-android-runtime.md)을 선택하면 테스트 서명과 설치·실행·화면 비교까지 진행합니다.

네이티브는 [Ghidra → Codex C/C++ 재구성 → 빌드 → CLI 사례 비교](personal-native-recovery.md)를 추가했습니다. 원본 위치의 실행 관찰과 원본 접근을 차단한 후보 실행을 비교하며, 범용 GUI 앱 전체 복원은 별도 과제입니다.
검사용 소형 fixture의 성공을 임의 상용 앱이나 전체 앱 복원 성공으로 일반화하지 않습니다.

기본 HTTP 검사에는 실제 ASAR 추출·JS 분석, 등록하지 않은 파일 및 변경된 파일의 거부가 포함됩니다.
DMG 추출은 기존 NativeDmgArtifactReader와 자원 소유권 관리 코드를 재사용하여 마운트·해제·실패 정리를 유지합니다.
전체 파일을 무조건 복제하지 않고 기존 안전 출력 경로와 해시 검증을 거칩니다.

## 다음 확장의 설계 기준

APK 서명·설치·실행은 Android SDK와 명시적으로 선택한 기기/에뮬레이터를 사용하는 별도 단계로 설계합니다.
서명 키는 저장소에 넣지 않습니다. 네이티브 재구현은 함수·ABI·리소스·의존성을 계약으로 나누고,
원본과 후보의 동일 입력 시나리오를 독립 실행해 비교해야 합니다. 실행·서명·의존성 정보가 없는 상태에서는 미검증으로 남깁니다.
