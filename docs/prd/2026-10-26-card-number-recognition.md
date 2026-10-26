# PRD: 자사 카드 번호 인식 앱

- Date: 2026-10-26
- status: in-progress

## Goal

새 앱에서 카메라에 비춘 자사 카드 한 면의 카드번호 16자리, 만료일, 활성화 번호 12자리를 기기 안에서 인식한다. 인식 결과는 확인 화면에서 고치거나, 다시 찍거나, 직접 입력할 수 있다. 서버 등록과 발급 기록 대조는 이번에 하지 않는다.

## Decisions

- 앱 위치 -> 새 앱 `apps/card` (User choice)
- 앱 구조 -> 화면 앱과 서버 앱을 분리한다. 이번에는 화면 앱만 만든다 (User choice)
- 서버 등록과 발급 DB 대조 -> 이번에는 하지 않고 번호 인식만 한다 (User choice)
- 카메라 코드 -> `apps/web`에서 새 앱으로 복사한다. `apps/web`은 건드리지 않는다 (User choice)
- 카드 테두리 -> 찾지 않는다. 가이드 주변 영역을 프레임마다 그대로 읽고, 글자 줄 기울기만큼 화면을 돌려 읽는다. 원근 때문에 글자가 비스듬한 것은 학습 데이터에 섞는다. 복사했던 카드 검출, 원근 보정, 품질 판정 코드는 뺀다 (User choice: "이건 사진을 찍는게 목표가 아니라 orc 이 주 목표", 테두리 없이 바로 읽기)
- 숫자 판별 -> 여러 글꼴로 학습한 작은 자체 모델. 가중치는 JS에 넣고, ML 런타임 없이 직접 짠 추론 코드로 돌린다 (User choice)
- 학습 환경 -> Python + PyTorch 학습 스크립트. 학습한 가중치를 JS 파일로 내보낸다 (User choice)
- Python 설치와 의존성 관리 -> uv. Python 버전과 패키지는 `pyproject.toml`과 `uv.lock`으로 고정하고 `uv run`으로 실행한다 (User choice)
- 숫자 글꼴 -> 모든 디자인이 Arial 계열(굵기, 폭만 다름). Arial 계열 전부로 학습한다 (User choice)
- 글꼴 파일 -> 커밋하지 않는다. 학습 스크립트가 macOS 시스템 Arial(`/System/Library/Fonts/Supplemental/Arial*.ttf`)을 경로로 읽는다 (User choice: Arial은 상용 글꼴이라 재배포 라이선스 문제)
- 실물 카드 사진 -> 커밋하지 않는다. 저장소 밖 폴더에 두고 경로를 스크립트에 넘긴다 (User choice. 폴더 경로를 넘기는 방식은 Follows existing approach: `apps/web/scripts/detect-eval.mts`)
- 손상 판정과 여권 판별 -> 새 앱에 넣지 않는다 (User choice)
- 확인 화면 -> 칸별 숫자 수정, 다시 찍기, 직접 입력으로 가기 (User choice)
- 배포 -> 이번에는 로컬과 폰(LAN) 실행만 한다 (User choice)
- 칸 찾기 -> 위치 좌표가 아니라 숫자 개수와 형식으로 칸을 구분한다. 숫자 16개는 카드번호, `/`가 들어간 4자리는 만료일, 숫자 12개는 활성화 번호다 (Specified in instructions: 디자인이 다양하고 라벨 형식이 불확실함)
- 셔터 버튼 없이 화면을 계속 읽는다 (Follows existing approach: `apps/web/src/components/scanner.tsx` 자동 촬영)
- 글자 줄 찾기 -> 여권 MRZ 줄 찾기와 같은 방식(가로 기울기 -> 가로로 잇기 -> 외곽선)을 숫자 줄에 맞게 조정한다 (Follows existing approach: `apps/web/public/detector-core.js:898` `findMrz`)

## Research

- `apps/web`은 정적 export(`output: "export"`)이고 서버 코드가 없다 - Source: `apps/web/next.config.ts`
- 저장소에는 글자를 읽는 기능이 없다. `findMrz`는 MRZ 줄 위치만 찾고 글자는 읽지 않는다 - Source: `apps/web/public/detector-core.js:894-897` 주석, `grep -ril "ocr|tesseract" apps/web/src` 결과 없음
- OpenCV.js 빌드에 있는 함수: approxPolyDP, arcLength, Canny, contourArea, cvtColor, dilate, findContours, GaussianBlur, getPerspectiveTransform, getStructuringElement, HoughLinesP, isContourConvex, Laplacian, Sobel, threshold, warpPerspective, createCLAHE + core 4개(convertScaleAbs, countNonZero, mean, meanStdDev). 새 앱은 같은 `@kyc-scanner/opencv` 패키지를 쓸 수 있다 - Source: `packages/opencv/opencv.config.py`, `apps/web/package.json`의 `opencv` 스크립트
- macOS에 Arial 계열 11종이 있다(Arial, Bold, Italic, Bold Italic, Black, Narrow 4종, Rounded Bold, Unicode) - Source: `ls /System/Library/Fonts/Supplemental/ | grep -i arial`
- 학습 환경: uv가 받은 CPython 3.12.15, torch 2.14.1, opencv-python-headless 5.0.0, numpy 2.5.4, pillow 13.0.0 - Source: `uv sync` 후 버전 출력
- 합성 검증 세트 정확도 99.45%(int8 가중치, 글자 비스듬함과 가로 늘어남 포함), 가중치 gzip 29KB - Source: `train.py` 출력, `gzip -c public/digit-model.js | wc -c`
- 이 기기의 시스템 Python은 3.9.6이고 numpy, torch가 없다. uv 0.13.1이 설치되어 있다 - Source: `python3 --version`, `python3 -c "import torch"`, `python3 -c "import numpy"`, `uv --version` 실행 결과
- pnpm 워크스페이스는 `apps/*`, `packages/*`를 포함하므로 `apps/card`는 따로 설정하지 않아도 워크스페이스에 들어간다. 루트 스크립트는 `--filter web`만 부른다 - Source: `pnpm-workspace.yaml`, 루트 `package.json`
- 폰 카메라는 HTTPS가 필요하고, `apps/web`은 `dev:phone`(LAN 인증서로 `--experimental-https`)으로 띄운다 - Source: `apps/web/package.json`의 `dev:phone`

## Requirements checklist

### Requirements from the instructions

- [x] `apps/card` Next.js 앱을 만든다. 서버 코드는 없다 - Source: "새 앱으로 만들어줘", "서버는 이번에 안 만듦"
- [x] 카메라 코드를 `apps/web`에서 `apps/card`로 복사하고, 카드를 비추면 가이드 주변 영역을 프레임마다 읽는다. 카드 테두리를 찾지 않는다 - Source: "새 앱에 복사", "orc 이 주 목표"
- [x] 가이드 영역 이미지에서 글자 줄 기울기를 바로잡고 숫자 줄을 찾고, 줄마다 숫자를 한 글자씩 잘라낸다. 디자인별 좌표를 쓰지 않는다 - Source: "디자인에 따라서 하기에는 종류가 다양한데"
- [x] 숫자 개수와 형식으로 카드번호(16자리), 만료일, 활성화 번호(12자리)를 구분한다. 라벨 글자를 근거로 쓰지 않는다 - Source: "카드번호 16자리랑, 만료일, 12자리 활성화 번호", "4 확실치 않음"
- [x] 글꼴 파일로 숫자 0-9 이미지를 합성하고 흐림, 기울기, 노이즈, 반사를 섞어 학습 데이터를 만드는 Python 스크립트를 만든다 - Source: "1 다름", "Python + PyTorch", "사진·글꼴 둘 다 가능"
- [x] 작은 숫자 판별 모델을 PyTorch로 학습하고, 가중치를 앱에서 불러올 JS 파일로 내보내는 스크립트를 만든다 - Source: "작은 자체 모델", "Python + PyTorch"
- [x] 내보낸 가중치로 숫자를 판별하는 추론 코드를 JS로 직접 짜서 앱에 넣는다. ML 런타임 패키지를 추가하지 않는다 - Source: "작은 자체 모델"
- [x] 확인 화면에 세 칸(카드번호, 만료일, 활성화 번호)을 보여 주고, 칸을 누르면 숫자 키패드로 고칠 수 있다 - Source: "칸별 숫자 수정"
- [x] 확인 화면에 다시 찍기를 두어 촬영 화면으로 돌아간다 - Source: "다시 찍기"
- [x] 촬영 화면에서 빈 세 칸에 직접 입력하는 화면으로 넘어갈 수 있다 - Source: "직접 입력으로 가기"

### Derived requirements

- [x] 한 프레임 결과로 확정하지 않는다. 여러 프레임에서 세 칸이 같은 값으로 읽힐 때 확정하고, 그때까지는 촬영 화면에서 계속 읽는다 - Basis: 카드번호와 활성화 번호에 체크섬이 없어("2 없음") 오인식을 거를 다른 방법이 없음
- [x] 형식 검사: 카드번호 16자리, 활성화 번호 12자리, 만료일 월 01-12. 직접 입력과 수정에도 같은 검사를 적용한다
- [x] 카드번호 Luhn 검사: 통과 못 하는 16자리는 카드번호로 읽지 않고, 직접 입력과 수정에서도 오류로 보인다 - Source: Findings의 User decision - Basis: 체크섬이 없어 클라이언트에서 할 수 있는 검사가 이것뿐임
- [x] 저장소 밖 실물 카드 사진 폴더 경로를 받아 숫자별, 칸별 정확도와 프레임당 시간을 표로 출력하는 평가 스크립트를 만든다 (`pnpm --filter card eval:digits <폴더>`) - Basis: 정확도를 재지 않으면 모델이 쓸 만한지 판단할 수 없음. 같은 방식의 기존 스크립트 `apps/web/scripts/detect-eval.mts`
- [x] 모델 가중치 JS 파일 크기를 100KB(gzip) 이하로 맞춘다 - Basis: 고령 사용자용 가벼운 앱 원칙(ML 런타임 금지, OpenCV 약 0.72MB gzip)
- [x] 인식한 번호와 촬영 이미지를 localStorage, 콘솔 로그 등 어디에도 남기지 않는다 - Basis: 활성화 번호는 비밀번호처럼 쓰이는 값
- [x] `apps/card`에 `opencv`, `dev`, `dev:phone`, `build`, `lint`, `test` 스크립트를 둔다 - Basis: 폰 카메라는 HTTPS가 필요하고("이번엔 로컬 실행만"), OpenCV 파일을 `public/`으로 복사해야 동작함 (`apps/web/package.json`)
- [x] 숫자 줄 찾기, 칸 구분, 형식 검사, 프레임 투표, JS 추론(PyTorch 출력과 일치)에 단위 테스트를 둔다 (`apps/card/tests/*.mts`) - Basis: 기존 테스트 방식 `apps/web/tests`, `node --test`

## Done criteria

- `pnpm --filter card test`
- `pnpm --filter card lint`
- `pnpm --filter card build`
- `pnpm --filter card eval:digits <폴더>` 결과 표를 보고서에 남긴다
- 사람이 확인: `pnpm --filter card dev:phone`으로 폰에서 디자인별 실물 카드를 비춰 세 칸이 자동으로 채워지는지, 수정, 다시 찍기, 직접 입력이 되는지 본다
- On hold: awaiting user confirmation (폰 확인. 실물 사진 6장은 앱 화면처럼 찍은 사진이 아니라 `eval:digits` 표가 앱 결과를 대표하지 않음: 카드 영역을 손으로 잡아 읽으면 55도 돌린 1장을 뺀 5장 중 4장 세 칸 모두 맞음, 1장(검은 매트) 못 읽음, 잘못 읽은 칸 0)
- On hold: 아이폰 15 Pro Max에서 확정이 안 됨. 4K 프레임은 선명하나 흰 글씨가 번져 활성화 번호 앞쪽의 연속된 0과 만료일(MM/YY)이 한 덩어리로 붙어 "other"로 읽힘(프레임 약 16장 중 1장만 읽힘). 갤럭시 A53은 사용자 확인에서 잘 됨. 원본 해상도로 읽기 시험 대기

## Out of scope

- 서버 앱, 등록 API, 발급 기록 대조, 활성화 시도 횟수 제한 - Basis: "서버는 이번에 안 만듦", "지금은 번호 인식만 할거야"
- 확인 화면의 등록 버튼과 서버 전송 - Basis: 서버를 만들지 않음
- 배포 설정(`.github/workflows/pages.yml`에 새 앱 추가 등) - Basis: "이번엔 로컬 실행만"
- `apps/web` 수정, 공용 패키지로 분리 - Basis: "새 앱에 복사"
- 확인 화면에서 확신이 낮은 숫자를 강조하기 - Basis: 확인 화면 질문에서 선택하지 않음
- Tesseract.js, 서버 OCR - Basis: "작은 자체 모델"
- 카드에 QR 넣기 - Basis: "qr 삽입은 불가능"
- 디자인별 좌표 템플릿 - Basis: "디자인에 따라서 하기에는 종류가 다양한데"
- 글꼴 파일 커밋 - Basis: removed by user ("커밋 안 함, 시스템 글꼴 사용")
- 실물 카드 사진 커밋 - Basis: "사진은 커밋 하지 않을거야"
- 카드 테두리 검출, 원근 보정, 품질 판정(흐림, 반사, 밝기 안내), 반사 때 노출 낮추기 - Basis: 테두리 없이 바로 읽기 선택
- 복사한 코드의 손상 판정(`inspectDamage`)과 여권 판별(`findMrz`, `passportFromMrz`, `documentKind`) - Basis: "2빼". 숫자 줄 찾기는 `findMrz` 방식을 참고하되 여권 판별 자체는 옮기지 않음

## Assumptions / Open questions

- Assumption: 카드는 신분증과 같은 ID-1 크기(85.6 x 54mm)라 가이드 틀을 그 비율로 그린다
- Assumption: 만료일은 MM/YY 형식(숫자 4개 + 구분자)이다
- Assumption: 카드번호 16자리와 활성화 번호 12자리는 각각 한 줄에 인쇄되어 있다(띄어쓰기는 있어도 됨)

## Findings

- 실물 카드의 카드번호가 Luhn 체크섬을 통과함(결제 카드 번호 체계). PRD는 "체크섬 없음" 전제라 쓰지 않았음. 쓰면 카드번호 오인식 대부분을 한 번에 거를 수 있음
  - User decision: add to checklist (아이폰에서 틀린 값으로 확정되는 문제 보고 후 "카드번호 Luhn 검사 추가")
