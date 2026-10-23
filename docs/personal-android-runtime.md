# APK 서명과 전용 에뮬레이터 실행 비교

Personal REA는 Apktool로 재빌드한 APK를 정렬하고 전용 로컬 테스트 키로
서명한 뒤 Android 전용 에뮬레이터에서 원본과 후보를 각각 설치·실행합니다.
원본과 후보는 동일 package, versionCode, versionName, launch activity여야 합니다.
이 경로는 Smali·리소스 재빌드 검증이며 원래 Java/Kotlin 소스나 배포 인증서 복구가 아닙니다.

## 도구와 장치

필수 도구는 Android SDK Build Tools **35.0.0**, Platform Tools **37.0.0**,
선택한 Java 실행 파일입니다. SDK와 APK 경로는 절대 경로로 지정합니다.
코드는 도구 버전과 실행 파일 SHA-256을 영수증에 기록하며 자동 다운로드하지 않습니다.

로컬 설치에는 전용 AVD `personal_rea_api35`와 `emulator-5580`을 사용합니다.
전용 Emulator **37.2.12**, Google APIs Android 35 ARM64 이미지 **revision 9**는
`~/.local/share/rea-personal/tools/android-sdk`에 있습니다.
이미 수락되어 있던 SDK 라이선스 범위에서 설치했으며 새 약관을 자동 수락하지 않습니다.
다른 PC에서는 해당 도구와 라이선스, 전용 AVD 준비가 필요합니다.

AVD 소유권 파일은
`~/.local/share/rea-personal/android-avd/personal_rea_api35.owner.json`입니다.
`schema_version: 1`, `avd_name: "personal_rea_api35"`,
`purpose: "personal-rea-dedicated-verification"`을 기록합니다.
이는 이미 존재하는 임의 AVD를 승인하는 방법이 아니라 REA 용도로 새로 만든 AVD의
준비 기록입니다. 기존 장치나 실제 휴대전화에는 이 경로로 설치하지 않습니다.
선택한 serial의 AVD 이름과 emulator 속성을 다시 확인합니다.

에뮬레이터가 없으면 작업이 소유한 프로세스로 시작하고 부팅 완료를 기다립니다.
작업이 시작한 프로세스는 마지막에 소유권을 검증하며 종료합니다.
동일 AVD를 사용하는 작업은 파일 잠금으로 직렬화합니다.
기존에 대상 package가 설치되어 있으면 데이터 덮어쓰기를 피하기 위해 중단합니다.

## 서명

순서는 `zipalign → apksigner sign → apksigner verify → zipalign -c`입니다.
APK에 사용된 테스트 인증서 SHA-256과 서명된 APK 해시를 결과에 표시합니다.
키와 암호 파일은 `~/.local/share/rea-personal/android-signing`에 0600 권한으로
보관합니다. 암호는 명령줄 값이나 작업 로그에 기록하지 않고 파일로 전달합니다.
키는 개인 릴리스용이 아니며 Git에 업로드하지 않습니다.

서명이 바뀌므로 signature 권한, 앱 간 연동, 원본 업데이트, 결제·인증 서버의
인증서 검사 등은 원본과 같다고 보장할 수 없습니다. 원본 서명 키를 복구하지 않습니다.

## 실행 검증과 증거

원본과 후보를 순차 설치하여 동일한 시나리오를 수행하고 각 설치본을 제거합니다.
제거 전 설치된 base.apk의 SHA-256이 이 작업의 APK와 일치하는지 다시 검사합니다.
취소·실패 시에도 정리를 시도하고 실패하면 대상 serial/package/해시를 보존합니다.

각 시나리오에는 이름, 제한된 좌표 탭 목록, BACK/ENTER/TAB 키 목록, 대기 시간을
지정할 수 있습니다. 최대 5개 시나리오, 각 10개 탭과 10개 키, 최대 10초 대기입니다.
시나리오는 한 번 실행한 앱에서 순서대로 누적됩니다. 좌표는 기기 해상도에 따라 다릅니다.

```json
[
  { "name": "시작 화면", "waitMs": 1500 },
  { "name": "메뉴 열기", "taps": [{ "x": 170, "y": 350 }], "waitMs": 1200 },
  { "name": "뒤로", "keys": ["BACK"], "waitMs": 1200 }
]
```

증거는 `android-runtime/receipt.json`과 같은 폴더의 XML, PNG, log 파일입니다.
설치 결과, `am start -W`, PID, foreground activity, UI hierarchy,
프로세스 logcat, crash buffer, 스크린샷과 파일 해시를 보존합니다.
대상 package의 UI 노드만 비교하므로 시스템 시계 변경은 텍스트 비교에서 제외됩니다.
화면 좌표, 텍스트, 체크·포커스 등 상태는 비교에 포함합니다.
스크린샷 해시 일치 여부는 별도로 표시합니다.

`verified`는 선택한 시나리오에서 앱 프로세스와 foreground를 확인했고
UI 노드가 같으며 수집한 프로세스 로그에 fatal exception이 없었다는 뜻입니다.
네트워크, 모든 기능, 장시간 동작, 보안·결제 흐름의 동등성을 뜻하지 않습니다.
crash buffer는 원문 증거이며 이전 시스템 항목을 현재 작업 오류로 단정하지 않습니다.

## 실제 도구 검증

```sh
node personal/ui/android-proof.mjs \
  /absolute/original.apk /absolute/rebuilt-unsigned.apk \
  /absolute/new-proof-folder /absolute/android-sdk /absolute/java \
  emulator-5580 personal_rea_api35
```

스크립트는 실제 정렬·서명·설치와 3개 화면 시나리오를 검증합니다.
기본 좌표는 로컬 ApiDemos/Pixel 7 검증용이므로 다른 앱에는 시나리오를 수정해야 합니다.

공식 근거: [APK 서명](https://developer.android.com/tools/apksigner),
[zipalign](https://developer.android.com/tools/zipalign),
[ADB](https://developer.android.com/tools/adb),
[Emulator 명령줄](https://developer.android.com/studio/run/emulator-commandline).
