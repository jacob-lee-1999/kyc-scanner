"use client";

import { useEffect, useRef, useState } from "react";
import { cameraFailure, openCamera, refocus, tuneTrack, type CameraFailure } from "@/lib/camera";
import {
  analysisSource,
  clampRect,
  coverMap,
  drawable,
  guideRect,
  READ_PAD,
  stageRectToVideo,
  type Rect,
} from "@/lib/geometry";
import { EMPTY, NO_VOTES, settled, vote, type Numbers, type Read, type Votes } from "@/lib/fields";
import NumberForm from "@/components/number-form";

const FRAME_GAP_MS = 120;
// Width the frame around the guide is read at: a card filling the guide comes out
// about 1000px wide (READ_PAD), its digits 25-45px tall, as trained.
const READ_WIDTH = 1300;
// This many frames in a row with no number: the card is gone and votes start over
// for the next one. Counted in frames, not time: a slow phone reads few per second.
const GONE_FRAMES = 3;
// No number read this long: focus again, in case the lens settled on the background.
const REFOCUS_MS = 4000;
const READING = "번호를 읽고 있습니다. 그대로 있어 주세요";
const PLACE = "번호가 있는 면을 틀 안에 놓아 주세요";

type Failure = CameraFailure | "engine";
// confirm: numbers read off the card; manual: typed in from empty.
type Phase = "scan" | "confirm" | "manual";

const FAILURE_TEXT: Record<Failure, string> = {
  permission: "카메라 권한이 필요합니다. 브라우저 설정에서 카메라를 허용한 뒤 다시 시도해 주세요.",
  missing: "이 기기에서 카메라를 찾지 못했습니다.",
  insecure:
    "카메라를 쓰려면 보안 연결(https)이 필요합니다. 휴대폰에서는 pnpm dev:phone 으로 연 주소로 접속해 주세요.",
  unsupported: "이 브라우저는 카메라 촬영을 지원하지 않습니다.",
  busy: "카메라를 켜지 못했습니다. 다른 앱이 카메라를 사용 중이면 닫고 다시 시도해 주세요.",
  unknown: "카메라를 켜지 못했습니다. 다시 시도해 주세요.",
  engine: "인식 엔진을 불러오지 못했습니다. 다시 시도해 주세요.",
};

// The part of the video around the guide that is read, or null before the video has a size.
function readRegion(video: HTMLVideoElement, view: { w: number; h: number }, widthFraction: number): Rect | null {
  if (video.videoWidth < 16 || video.videoHeight < 16 || view.w < 16 || view.h < 16) return null;
  const map = coverMap(view.w, view.h, video.videoWidth, video.videoHeight);
  const guide = stageRectToVideo(guideRect(view.w, view.h, widthFraction), map);
  const visible = stageRectToVideo({ x: 0, y: 0, width: view.w, height: view.h }, map);
  const padded = analysisSource(guide, READ_PAD, video.videoWidth, video.videoHeight);
  return drawable(clampRect(padded, visible), video.videoWidth, video.videoHeight);
}

export default function Scanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<{ retake: () => void; typeIn: () => void } | null>(null);
  const viewRef = useRef({ w: 0, h: 0 });
  const guideFraction = 0.72;

  const [session, setSession] = useState(0);
  const [view, setView] = useState({ w: 0, h: 0 });
  const [phase, setPhase] = useState<Phase>("scan");
  const [numbers, setNumbers] = useState<Numbers>(EMPTY);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [reading, setReading] = useState(false);
  const [flash, setFlash] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let mode: "scan" | "done" | "error" = "scan";
    let busy = false;
    let engineReadyNow = false;
    let cameraReadyNow = false;
    let lastSent = 0;
    let loopOn = false;
    let busyTimer = 0;
    let frameId = 0;
    let focusSettlesAt = 0;
    let lastRead = 0;
    let lastRefocus = 0;
    let emptyFrames = 0;
    // Reads of the card in view so far; kept only in memory, never stored.
    let votes: Votes = NO_VOTES;
    const canvas = document.createElement("canvas");
    const worker = new Worker(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/reader.worker.js?v=card-reader-6`);

    const measure = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const next = { w: rect.width, h: rect.height };
      viewRef.current = next;
      setView(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);

    const schedule = () => {
      if (!loopOn || cancelled) return;
      if ("requestVideoFrameCallback" in video) {
        video.requestVideoFrameCallback(() => tick());
      } else {
        window.setTimeout(tick, FRAME_GAP_MS);
      }
    };
    const startLoop = () => {
      if (loopOn || cancelled || mode !== "scan" || !engineReadyNow || !cameraReadyNow) return;
      loopOn = true;
      lastRead = performance.now();
      schedule();
    };
    const fail = (kind: Failure) => {
      if (cancelled || mode === "error") return;
      mode = "error";
      loopOn = false;
      stream?.getTracks().forEach((track) => track.stop());
      setFailure(kind);
    };
    // Leave the camera for the number form; the preview stops.
    const finish = (next: Phase, values: Numbers) => {
      window.clearTimeout(busyTimer);
      mode = "done";
      loopOn = false;
      busy = false;
      votes = NO_VOTES;
      const track = stream?.getVideoTracks()[0];
      if (track) track.enabled = false;
      setReading(false);
      setNumbers(values);
      setPhase(next);
    };

    const tick = () => {
      if (!loopOn || cancelled || mode !== "scan") return;
      const now = performance.now();
      // Drop the frame while the last one is still being read. Never queue work behind the preview.
      if (!busy && !document.hidden && now - lastSent >= FRAME_GAP_MS && now >= focusSettlesAt && video.readyState >= 2) {
        const region = readRegion(video, viewRef.current, guideFraction);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (region && context) {
          canvas.width = READ_WIDTH;
          canvas.height = Math.round((region.height * READ_WIDTH) / region.width);
          context.imageSmoothingQuality = "high";
          context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          busy = true;
          lastSent = now;
          window.clearTimeout(busyTimer);
          busyTimer = window.setTimeout(() => fail("engine"), 5000);
          worker.postMessage(
            { type: "frame", frameId: ++frameId, buffer: pixels.buffer, width: canvas.width, height: canvas.height },
            [pixels.buffer],
          );
        }
      }
      schedule();
    };

    worker.onmessage = (event: MessageEvent) => {
      if (cancelled) return;
      const data = event.data as { type: string; frameId?: number; fields?: Read };
      if (data.type === "ready") {
        engineReadyNow = true;
        setEngineReady(true);
        startLoop();
        return;
      }
      if (data.type === "error") {
        window.clearTimeout(busyTimer);
        busy = false;
        fail("engine");
        return;
      }
      if (data.type !== "read" || data.frameId !== frameId || !data.fields) return;
      window.clearTimeout(busyTimer);
      busy = false;
      if (mode !== "scan") return;
      const now = performance.now();
      if (Object.values(data.fields).some(Boolean)) {
        lastRead = now;
        emptyFrames = 0;
        setReading(true);
        votes = vote(votes, data.fields);
        const values = settled(votes);
        if (values) {
          setFlash((value) => value + 1);
          navigator.vibrate?.(30);
          finish("confirm", values);
        }
        return;
      }
      if (++emptyFrames >= GONE_FRAMES && votes !== NO_VOTES) {
        votes = NO_VOTES;
        setReading(false);
      }
      const track = stream?.getVideoTracks()[0];
      if (track && now - lastRead >= REFOCUS_MS && now - lastRefocus >= REFOCUS_MS) {
        lastRefocus = now;
        focusSettlesAt = now + 800;
        void refocus(track).catch(() => undefined);
      }
    };
    worker.onerror = () => {
      fail("engine");
    };

    const engineTimer = window.setTimeout(() => {
      if (!engineReadyNow) fail("engine");
    }, 25000);

    controlsRef.current = {
      retake() {
        if (cancelled) return;
        mode = "scan";
        votes = NO_VOTES;
        focusSettlesAt = performance.now() + 800;
        setReading(false);
        setNumbers(EMPTY);
        setPhase("scan");
        const track = stream?.getVideoTracks()[0];
        if (track) track.enabled = true;
        void video.play().catch(() => undefined);
        startLoop();
      },
      typeIn() {
        if (cancelled) return;
        finish("manual", EMPTY);
      },
    };

    openCamera()
      .then(async (next) => {
        if (cancelled) {
          next.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = next;
        video.srcObject = next;
        const track = next.getVideoTracks()[0];
        if (track) {
          await tuneTrack(track);
        }
        if (cancelled) {
          next.getTracks().forEach((item) => item.stop());
          return;
        }
        await video.play();
        if (cancelled) return;
        focusSettlesAt = performance.now() + 800;
        cameraReadyNow = true;
        setCameraReady(true);
        startLoop();
      })
      .catch((error: unknown) => {
        fail(cameraFailure(error));
      });

    return () => {
      cancelled = true;
      loopOn = false;
      window.clearTimeout(engineTimer);
      window.clearTimeout(busyTimer);
      observer.disconnect();
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      stream?.getTracks().forEach((track) => track.stop());
      controlsRef.current = null;
    };
  }, [session]);

  function retry() {
    setFailure(null);
    setPhase("scan");
    setNumbers(EMPTY);
    setCameraReady(false);
    setEngineReady(false);
    setReading(false);
    setSession((value) => value + 1);
  }

  const ready = cameraReady && engineReady;
  const guide = view.w > 0 ? guideRect(view.w, view.h, guideFraction) : null;
  const statusText = !cameraReady
    ? "카메라를 켜고 있습니다"
    : !engineReady
      ? "인식 엔진을 준비하고 있습니다"
      : reading
        ? READING
        : PLACE;

  return (
    <main className="scanner" data-tone={ready && reading ? "ready" : "idle"}>
      <div className="stage" ref={stageRef} hidden={phase !== "scan" || failure != null}>
        <video ref={videoRef} playsInline muted autoPlay aria-hidden="true" />
        {guide && (
          <div
            className="guide"
            style={{ left: guide.x, top: guide.y, width: guide.width, height: guide.height }}
          >
            <span className="corner tl" />
            <span className="corner tr" />
            <span className="corner bl" />
            <span className="corner br" />
          </div>
        )}
        <div className="topbar">
          <h1>카드 번호 인식</h1>
          <p className="instructions">번호가 있는 면을 대략 가운데 놓아 주세요.<br />틀에 정확히 맞추지 않아도 됩니다.</p>
        </div>
        <div className="bottom">
          <p className="status" role="status">
            {statusText}
          </p>
          {phase === "scan" && (
            <button type="button" className="photo" onClick={() => controlsRef.current?.typeIn()}>
              직접 입력하기
            </button>
          )}
        </div>
      </div>

      {(phase === "confirm" || phase === "manual") && failure == null && (
        <NumberForm
          key={phase}
          title={phase === "confirm" ? "번호를 확인해 주세요" : "번호를 입력해 주세요"}
          note={phase === "confirm" ? "카드와 다르면 칸을 눌러 고쳐 주세요." : "카드에 적힌 번호를 그대로 입력해 주세요."}
          initial={numbers}
          onRetake={() => controlsRef.current?.retake()}
        />
      )}

      <section className="error-view" hidden={failure == null}>
        <h1>촬영을 시작하지 못했습니다</h1>
        <p>{failure ? FAILURE_TEXT[failure] : ""}</p>
        <button type="button" className="primary" onClick={retry}>
          다시 시도
        </button>
      </section>

      {flash > 0 && phase === "confirm" && <div key={flash} className="flash" />}
    </main>
  );
}
