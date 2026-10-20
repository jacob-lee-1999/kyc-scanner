# 신분증 촬영

휴대폰 카메라로 신분증을 네모 틀에 맞추면, 빛 반사와 흐림이 없을 때 자동으로 잘라 둡니다. 사진 처리는 브라우저 안에서만 일어나고 서버로 보내지 않습니다.

## 실행

```bash
pnpm install
pnpm test
pnpm dev
```

같은 컴퓨터에서는 http://localhost:3000 을 엽니다.

휴대폰 카메라는 HTTPS에서만 동작합니다.

```bash
pnpm dev:phone
```

터미널에 나온 `https://` 주소로 접속합니다. 처음 한 번은 인증서를 신뢰해야 합니다.

촬영 화면에는 품질 수치나 개발 표시를 노출하지 않습니다.


## 자동촬영 품질 검사

- 수동 최단거리 고정 대신 지원되는 자동초점을 사용합니다.
- 특정 기기 화각으로 거리를 추정하지 않고, 화면 너비의 72%인 가이드를 사용합니다.
- 분석용 이미지와 저장 이미지는 같은 원본 스냅샷에서 만듭니다. 프레임 ID가 다른 응답과 오래된 분석 결과는 사용하지 않습니다.
- 네 모서리 확인과 품질 조건 통과가 최소 700ms, 2프레임 이상 유지되어야 촬영합니다. 분석 간격이 800ms를 넘으면 안정화 시간을 다시 셉니다.
- 카드 내부를 3×3 영역으로 나눠 각 가로 구간의 상세 영역을 찾고, 세 가로 구간 중 두 구간 이상에서 선명도를 확인합니다.
- 반사는 포화 픽셀 비율과 연결된 밝은 영역 크기로 판정합니다. 작은 점 하나로 촬영을 막지 않습니다.
- 모든 이미지 처리는 로컬 Worker와 Canvas에서 수행합니다.

현재 기준은 합성 이미지와 갤럭시 A53 한 대의 실기기 관찰로 조정한 초기값입니다. 반사 감지는 글자 의미를 읽는 OCR 검사가 아니므로, 흰 바탕이나 홀로그램에서 오탐이 남을 수 있습니다.

## 실기기 확인

갤럭시 Chrome과 iPhone Safari에서 다음을 확인하세요. 실제 신분증 대신 테스트용 카드를 사용할 수 있습니다.

1. 가까운 거리에서 시작해 조금 멀어졌을 때 자동초점이 따라오는지 확인합니다.
2. 일반 조명에서는 촬영되고, 글자를 덮는 반사나 부분적인 흐림에서는 촬영되지 않는지 확인합니다.
3. 네 모서리 중 일부가 가려지거나 손이 흔들릴 때 자동촬영되지 않는지 확인합니다.
4. 촬영 후 저장된 이미지의 글자가 선명한지 확인합니다.
5. 다시 촬영, 화면 회전, 앱 전환 후 복귀를 확인합니다.
6. 촬영 완료까지 걸린 시간과 잘못 통과하거나 거절된 사례를 기록하고 기준값을 조정합니다.

검증 명령: `pnpm test`, `pnpm lint`, `pnpm --filter web exec tsc --noEmit`, `pnpm build`.


## 구조

- `apps/web`: Next.js 앱
- `packages/opencv`: 스캐너가 쓰는 함수만 넣은 OpenCV.js 4.13.0 빌드 (`dist/opencv.js`, `dist/opencv_js.wasm`). `apps/web` 의 `dev`, `build` 가 `public/` 으로 복사합니다.

`detector-core.js` 에서 새 OpenCV 함수를 쓰려면 `packages/opencv/opencv.config.py` 에 추가하고 `pnpm --filter @kyc-scanner/opencv build` 로 다시 빌드합니다 (Docker 필요).


## A53 USB 테스트 기록 (2026-10-20)

- Chrome에서 후면 카메라 1080×1920, 연속 자동초점 적용을 확인했습니다.
- 중앙의 가림 종이가 기존 측정 영역을 차지해 선명도를 낮게 평가하는 문제가 있어, 카드 내부 여러 영역을 측정하도록 변경했습니다.
- 기존 영역별 검사에서 글자가 있는 패치는 약 239~372, 같은 패치에 1px Gaussian blur를 적용하면 약 51~74였습니다. 새 영역 선택 방식의 기준 180은 이 관찰을 바탕으로 정한 초기값이며 기기 공통 품질 보장이 아닙니다.
- 자동촬영 후 710×448 결과 화면까지 확인했습니다. 마지막 관찰은 선명도 213, 반사 비율 0, 모서리 검출 성공, 움직임 0.005, Worker 68ms였습니다.
- 결과의 보이는 글자는 읽히지만 작은 글자와 사진 윤곽은 다소 부드럽습니다. 이후 고해상도 및 최상 프레임 선택을 적용했습니다. 아래 후속 테스트 기록을 참고하세요.
- 실제 조명 반사에 대한 통제된 재현 테스트와 다른 휴대폰 검증은 아직 하지 않았습니다.
- 약한 인공 흐림은 선명도 감소를 검사하고, 강한 흐림은 촬영 거부를 검사합니다. 단일 점수로 모든 카드와 흐림 수준을 보장하지 않습니다.


## 고해상도 및 모서리 여백 개선

- 카메라에 3840×2160, 15fps를 요청합니다. 지원하지 않는 기기는 낮은 해상도로 대체합니다. 세로 방향에서는 가로·세로가 바뀔 수 있습니다.
- 분석은 카드 내부를 최대 660×440으로 축소해 수행하고, 저장할 원본은 고해상도를 유지합니다.
- 안정화 구간에서 품질 조건을 통과한 최근 후보 중 가장 선명한 프레임을 선택합니다. 후보는 한 장만 보관하고 1.2초를 넘기거나 품질 조건이 깨지면 교체합니다.
- 카드의 투영 평면을 각 방향으로 6% 확장해 실제 주변 배경까지 보정합니다. 원본에 여백이 없으면 촬영하지 않습니다.
- 출력 너비 상한은 2400픽셀입니다. 원본보다 확대해 디테일을 만들어내지 않습니다.
- A53에서 실제 입력 2160×3840 / 15fps와 자동촬영을 확인했습니다. 결과는 1609×1015이며 실제 배경과 네 모서리를 확인했습니다. 촬영 직전 관찰한 분석 시간은 Worker 125ms, 전체 428ms였습니다.
- 앞선 710×448 결과보다 화면상 작은 글자가 또렷해졌습니다. 실제 결과 크기는 카드 위치·거리·기기에 따라 달라집니다.


## 추가 실기기 재검증

- 4K 분석이 간헐적으로 500ms를 넘어 안정화가 반복 초기화되는 현상을 확인했습니다. 품질 임계값은 유지하고 분석 간격/응답 허용 시간을 800ms로 조정했습니다. 550ms 간격의 연속 프레임과 실제 긴 중단을 구분하는 회귀 테스트를 추가했습니다.
- 수정 후 자동촬영 1525×962 결과와 네 모서리의 배경 여백을 확인했습니다. 촬영 직전 Worker 137ms, 전체 479ms였습니다.
- 강한 반사 테스트에서 모서리가 검출된 상태로 반사 비율 약 17~18%, hotspot=true가 관찰됐으며 자동촬영이 차단되고 각도 변경 안내가 표시됐습니다.
- 반사 비율 0으로 통과한 결과에도 옅은 반사로 보이는 부분이 있어, 포화되지 않은 반사의 검출은 해결되지 않은 한계입니다.
- 프로덕션 빌드는 재시도해도 Turbopack CSS 처리 중 내부 포트 바인딩 EPERM으로 실패했습니다. 개발 서버를 통한 실기기 동작과 별도로 남아 있는 검증 항목입니다.

- Reflection recovery check: after the user removed the strong reflection, automatic capture resumed and produced 1534x967. The final observed frame had glareRatio=0, hotspot=false, sharpness=449, motion=0.012, worker=107ms, total=347ms.


## 비스듬한 촬영과 정면 보정

화면의 디버그 수치와 Next.js 개발 표시를 제거했습니다. `?debug=1`이 남아 있어도 수치를 표시하지 않습니다.

모서리를 가이드 네 귀퉁이에 일치시키는 대신, 카드 중심·면적·볼록한 네 모서리·변의 비율로 촬영 가능 여부를 판단합니다. 적당한 회전이나 원근 때문에 사다리꼴로 보이는 카드도 검출된 네 모서리의 원근 변환으로 실제 신분증 비율의 직사각형으로 보정합니다. 기존 6% 배경 여백은 유지합니다. 잘린 모서리, 심한 기울기, 흐림과 반사는 여전히 촬영을 막을 수 있습니다.

원근 보정에 실패하거나 시간이 초과되면 미보정 이미지를 성공 결과로 표시하지 않고 재시도를 안내합니다. 합성 사다리꼴의 중심선이 수직으로 보정되는 테스트와 기울어진 카드의 유효성 검사를 추가했습니다.

## GitHub Pages deployment

The `Deploy GitHub Pages` workflow tests and exports the app on pushes to `main`, then deploys `out/` using GitHub Pages Actions. Enable GitHub Actions as the Pages publishing source in repository settings. Private repositories require a GitHub plan that supports Pages.

Build locally for the project URL:

```bash
pnpm build
```

The static site is hosted at `https://kyc.namda-card.com/`. The Pages workflow builds with an empty `NEXT_PUBLIC_BASE_PATH` because the custom domain serves the app from `/`. `apps/web/public/CNAME` records the custom domain. Camera access requires HTTPS. Worker and OpenCV URLs are relative to the deployed project path. Images are processed locally; GitHub hosts only the application files.

The Pages static export was successfully built locally, including type checking, after removing unused server caching options. All 36 tests and lint passed.


## 가이드 정렬 부담 완화

- 가이드는 대략적인 위치 안내입니다. 검색 영역을 가이드 바깥으로 넓히고 화면에 보이는 범위 안에서 카드를 찾습니다.
- 카드 중심은 가이드 폭·높이의 38%까지 치우쳐도 허용하고, 카드 면적은 가이드 면적의 30~185%를 허용합니다. 네 모서리와 저장할 실제 배경 여백이 확보되어야 합니다.
- 인식된 카드에는 별도 윤곽선을 표시합니다. 가이드 밖을 어둡게 가리던 효과를 제거했습니다.
- 검출된 카드를 먼저 원근 보정한 뒤 그 카드의 밝기·반사·선명도를 검사합니다. 카드 밖의 밝은 배경이나 선명한 물체는 품질 점수에서 제외합니다.
- 원본 카드 너비가 600px 미만이면 가까이 오도록 안내합니다. 움직임은 검색창 대신 카드 크기를 기준으로 계산합니다.
- 연속 2프레임 및 최소 700ms, 선명도·반사 기준과 6% 저장 여백은 유지합니다.
- 작거나 치우친 카드, 배경 반사 제외, 흐린 카드/카드 반사 거부, Worker 메시지 연결을 포함해 44개 테스트를 통과했습니다. 이번 위치 허용 변경의 실기기 성공 촬영은 별도 확인이 필요합니다.
