"use client";

import { useEffect, useRef, useState } from "react";
import {
  cameraFailure,
  openCamera,
  refocus,
  tuneTrack,
  type CameraFailure,
} from "@/lib/camera";
import {
  EMPTY_STABILITY,
  evaluateFrame,
  LIMITS,
  type Reason,
  type Stability,
} from "@/lib/decide";
import {
  analysisSource,
  coverMap,
  detailWindow,
  detailSize,
  drawable,
  edgeSize,
  guideRect,
  GUIDE_PAD,
  relativeInner,
  stageRectToVideo,
  type Point,
  type Rect,
} from "@/lib/geometry";

import { paddedCapture, preferCandidate } from "@/lib/capture";

const FRAME_GAP_MS = 120;

type Failure = CameraFailure | "engine";
type Phase = "scan" | "result";
type Plan = {
  snapshot: Rect;
  guide: Rect;
  source: Rect;
  inner: Rect;
  detail: Rect;
  detailSize: { width: number; height: number };
  edge: { width: number; height: number };
};
const STATUS: Record<Reason, string> = {
  align: "신분증의 네 모서리가 보이게 틀 가운데 놓아 주세요",
  glare: "휴대폰을 옆으로 조금 기울여 주세요",
  dark: "너무 어둡습니다. 밝은 곳으로 옮겨 주세요",
  bright: "너무 밝아 글자가 날아갑니다. 각도를 바꿔 주세요",
  blur: "초점이 맞지 않습니다. 잠시 그대로 있어 주세요",
  move: "흔들렸습니다. 신분증을 고정해 주세요",
  hold: "선명합니다. 그대로 있어 주세요",
  ok: "촬영합니다",
};

const FAILURE_TEXT: Record<Failure, string> = {
  permission: "카메라 권한이 필요합니다. 브라우저 설정에서 카메라를 허용한 뒤 다시 시도해 주세요.",
  missing: "이 기기에서 카메라를 찾지 못했습니다.",
  insecure:
    "카메라를 쓰려면 보안 연결(https)이 필요합니다. 휴대폰에서는 npm run dev:phone 으로 연 주소로 접속해 주세요.",
  unsupported: "이 브라우저는 카메라 촬영을 지원하지 않습니다.",
  busy: "카메라를 켜지 못했습니다. 다른 앱이 카메라를 사용 중이면 닫고 다시 시도해 주세요.",
  unknown: "카메라를 켜지 못했습니다. 다시 시도해 주세요.",
  engine: "인식 엔진을 불러오지 못했습니다. 다시 시도해 주세요.",
};

function drawRegion(
  video: CanvasImageSource,
  canvas: HTMLCanvasElement,
  source: Rect,
  destW: number,
  destH: number,
): Uint8ClampedArray | null {
  if (canvas.width !== destW) canvas.width = destW;
  if (canvas.height !== destH) canvas.height = destH;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(video, source.x, source.y, source.width, source.height, 0, 0, destW, destH);
  return context.getImageData(0, 0, destW, destH).data;
}

function buildPlan(
  video: HTMLVideoElement,
  view: { w: number; h: number },
  widthFraction: number,
): Plan | null {
  if (video.videoWidth < 16 || video.videoHeight < 16 || view.w < 16 || view.h < 16) return null;
  const guide = stageRectToVideo(
    guideRect(view.w, view.h, widthFraction),
    coverMap(view.w, view.h, video.videoWidth, video.videoHeight),
  );
  const analyzed = analysisSource(guide, GUIDE_PAD, video.videoWidth, video.videoHeight);
  const source = drawable(analyzed.source, video.videoWidth, video.videoHeight);
  const detail = drawable(detailWindow(guide), video.videoWidth, video.videoHeight);
  if (!source || !detail) return null;
  const inner = relativeInner(guide, source);
  if (inner.width < 0.2 || inner.height < 0.2) return null;
  const snapshot = drawable(analysisSource(guide, 0.3, video.videoWidth, video.videoHeight).source, video.videoWidth, video.videoHeight);
  if (!snapshot) return null;
  const local = (rect: Rect): Rect => ({ ...rect, x: rect.x - snapshot.x, y: rect.y - snapshot.y });
  return { snapshot, guide: local(guide), source: local(source), inner, detail: local(detail), detailSize: detailSize(detail), edge: edgeSize(source) };
}

function toneFor(reason: Reason, ready: boolean): "idle" | "warn" | "ready" {
  if (!ready) return "idle";
  if (reason === "hold" || reason === "ok") return "ready";
  if (reason === "glare" || reason === "dark" || reason === "bright" || reason === "blur") return "warn";
  return "idle";
}

export default function Scanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const blobRef = useRef<Blob | null>(null);
  const controlsRef = useRef<{ retake: () => void } | null>(null);
  const viewRef = useRef({ w: 0, h: 0 });
  const reasonRef = useRef<Reason>("align");
  const stableRef = useRef(0);
  const guideFractionRef = useRef(0.72);

  const [session, setSession] = useState(0);
  const [view, setView] = useState({ w: 0, h: 0 });
  const [phase, setPhase] = useState<Phase>("scan");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [distanceHint, setDistanceHint] = useState(false);
  const [reason, setReason] = useState<Reason>("align");
  const [stable, setStable] = useState(0);
  const [flash, setFlash] = useState(0);
  const [guideFraction] = useState(0.72);

  useEffect(() => {
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let mode: "scan" | "capturing" | "result" | "error" = "scan";
    let busy = false;
    let engineReadyNow = false;
    let cameraReadyNow = false;
    let lastSent = 0;
    let lastRefocus = 0;
    let loopOn = false;
    let busyTimer = 0;
    let stability: Stability = { ...EMPTY_STABILITY };
    let frameId = 0;
    let pendingFrameId = 0;
    let sampledAt = 0;
    let blurSince = 0;
    let focusSettlesAt = 0;
    let shownAt = 0;
    const bestCanvas = document.createElement("canvas");
    let best: { score: number; at: number; frameId: number; crop: NonNullable<ReturnType<typeof paddedCapture>> } | null = null;
    const snapshot = document.createElement("canvas");
    const planRef: { current: Plan | null } = { current: null };
    const edgeCanvas = document.createElement("canvas");
    const detailCanvas = document.createElement("canvas");
    const worker = new Worker("/detector.worker.js");


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

    const stopLoop = () => {
      loopOn = false;
    };
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
      schedule();
    };
    const fail = (kind: Failure) => {
      if (cancelled || mode === "error") return;
      mode = "error";
      stopLoop();
      stream?.getTracks().forEach((track) => track.stop());
      setFailure(kind);
    };
    const publish = () => {
      const canvas = previewRef.current;
      if (!canvas) return;
      const publishedFrame = pendingFrameId;
      canvas.toBlob(
        (blob) => {
          if (cancelled || !blob || mode !== "result" || publishedFrame !== pendingFrameId) return;
          blobRef.current = blob;
        },
        "image/jpeg",
        0.95,
      );
    };
    const finishPreview = () => {
      window.clearTimeout(busyTimer);
      mode = "result";
      setPhase("result");
      publish();
    };

    const tick = () => {
      if (!loopOn || cancelled || mode !== "scan") return;
      const now = performance.now();
      // Drop the frame if OpenCV is still busy. Never queue work behind the preview.
      if (!busy && !document.hidden && now - lastSent >= FRAME_GAP_MS && now >= focusSettlesAt && video.readyState >= 2) {
        const plan = buildPlan(video, viewRef.current, guideFractionRef.current);
        if (plan) {
          if (snapshot.width !== plan.snapshot.width) snapshot.width = plan.snapshot.width;
          if (snapshot.height !== plan.snapshot.height) snapshot.height = plan.snapshot.height;
          const snapshotContext = snapshot.getContext("2d");
          if (!snapshotContext) { fail("engine"); return; }
          snapshotContext.drawImage(video, plan.snapshot.x, plan.snapshot.y, plan.snapshot.width, plan.snapshot.height, 0, 0, snapshot.width, snapshot.height);
          const edge = drawRegion(snapshot, edgeCanvas, plan.source, plan.edge.width, plan.edge.height);
          const detail = drawRegion(
            snapshot,
            detailCanvas,
            plan.detail,
            plan.detailSize.width,
            plan.detailSize.height,
          );
          if (edge && detail) {
            planRef.current = plan;
            pendingFrameId = ++frameId;
            sampledAt = now;
            busy = true;
            lastSent = now;
            window.clearTimeout(busyTimer);
            busyTimer = window.setTimeout(() => {
              fail("engine");
            }, 5000);
            worker.postMessage(
              {
                type: "frame",
                frameId: pendingFrameId,
                edge: { buffer: edge.buffer, width: plan.edge.width, height: plan.edge.height },
                detail: {
                  buffer: detail.buffer,
                  width: plan.detailSize.width,
                  height: plan.detailSize.height,
                },
                inner: plan.inner,
              },
              [edge.buffer, detail.buffer],
            );
          }
        }
      }
      schedule();
    };

    const capture = () => {
      if (!best) return;
      mode = "capturing";
      stopLoop();
      const { corners, size } = best.crop;
      const preview = previewRef.current;
      const context = bestCanvas.getContext("2d", { willReadFrequently: true });
      if (!preview || !context) { fail("engine"); return; }
      // Publish only after perspective correction succeeds.
      preview.width = bestCanvas.width;
      preview.height = bestCanvas.height;
      preview.getContext("2d")?.drawImage(bestCanvas, 0, 0);
      const pixels = context.getImageData(0, 0, bestCanvas.width, bestCanvas.height);
      busyTimer = window.setTimeout(() => fail("engine"), 5000);
      worker.postMessage({ type: "crop", buffer: pixels.data.buffer,
        width: bestCanvas.width, height: bestCanvas.height, corners,
        outWidth: size.width, outHeight: size.height }, [pixels.data.buffer]);
      setFlash(value => value + 1);
      navigator.vibrate?.(30);
      const track = stream?.getVideoTracks()[0];
      if (track) track.enabled = false;
    };

    worker.onmessage = (event: MessageEvent) => {
      if (cancelled) return;
      const data = event.data as {
        type: string;
        frameId?: number;
        ms?: number;
        buffer?: ArrayBuffer;
        width?: number;
        height?: number;
        sharpness?: number;
        glareRatio?: number;
        hotspot?: boolean;
        luma?: number;
        borderScore?: number;
        quad?: Point[] | null;
        aspect?: number | null;
      };
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
      if (data.type === "result" && mode === "capturing" && data.buffer && data.width && data.height) {
        const canvas = previewRef.current;
        if (canvas) {
          const pixels = new Uint8ClampedArray(data.buffer);
          canvas.width = data.width;
          canvas.height = data.height;
          canvas.getContext("2d")?.putImageData(new ImageData(pixels, data.width, data.height), 0, 0);
        }
        finishPreview();
        return;
      }
      if (data.type !== "metrics" || mode !== "scan" || data.sharpness == null || data.frameId !== pendingFrameId) return;
      window.clearTimeout(busyTimer);
      busy = false;
      const plan = planRef.current;
      if (!plan) return;
      if (document.hidden || performance.now() - sampledAt > LIMITS.maxGapMs) {
        stability = { ...EMPTY_STABILITY };
        best = null;
        return;
      }
      const decision = evaluateFrame(stability, {
        sharpness: data.sharpness,
        glareRatio: data.glareRatio ?? 1,
        hotspot: data.hotspot ?? true,
        luma: data.luma ?? 0,
        borderScore: data.borderScore ?? 0,
        quad: data.quad ?? null,
        aspect: data.aspect ?? null,
      }, plan.inner, sampledAt);
      if (decision.state.count === 1 || (decision.reason !== "hold" && !decision.capture)) best = null;
      stability = decision.state;
      if ((decision.reason === "hold" || decision.capture) && decision.quad) {
        const corners = decision.quad.map(p => ({ x: plan.source.x + p.x * plan.source.width, y: plan.source.y + p.y * plan.source.height }));
        const crop = paddedCapture(corners, snapshot.width, snapshot.height);
        if (!crop) {
          best = null;
          stability = { ...EMPTY_STABILITY };
          reasonRef.current = "align";
          setReason("align");
          setStable(0);
          return;
        }
        if (preferCandidate(best, data.sharpness, sampledAt)) {
          bestCanvas.width = crop.source.width;
          bestCanvas.height = crop.source.height;
          const ctx = bestCanvas.getContext("2d");
          if (!ctx) { fail("engine"); return; }
          ctx.drawImage(snapshot, crop.source.x, crop.source.y, crop.source.width, crop.source.height, 0, 0, bestCanvas.width, bestCanvas.height);
          best = { score: data.sharpness, at: sampledAt, frameId: pendingFrameId, crop };
        }
      }
      if (decision.reason !== reasonRef.current && performance.now() - shownAt >= 900) {
        shownAt = performance.now();
        reasonRef.current = decision.reason;
        setReason(decision.reason);
      }
      if (decision.state.count !== stableRef.current) {
        stableRef.current = decision.state.count;
        setStable(Math.min(LIMITS.stableFrames - 1, decision.state.count));
      }
      if (decision.reason === "blur") {
        blurSince ||= performance.now();
        setDistanceHint(performance.now() - blurSince > 3000);
        if (performance.now() - lastRefocus > 4000) {
          lastRefocus = performance.now();
          focusSettlesAt = performance.now() + 800;
          const track = stream?.getVideoTracks()[0];
          if (track) void refocus(track).catch(() => undefined);
        }
      } else {
        blurSince = 0;
        setDistanceHint(false);
      }
      if (decision.capture) capture();
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
        stability = { ...EMPTY_STABILITY };
        best = null;
        blurSince = 0;
        setDistanceHint(false);
        focusSettlesAt = performance.now() + 800;
        reasonRef.current = "align";
        stableRef.current = 0;
        blobRef.current = null;
        setReason("align");
        setStable(0);
        setPhase("scan");
        const track = stream?.getVideoTracks()[0];
        if (track) track.enabled = true;
        void video.play().catch(() => undefined);
        startLoop();
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
      stopLoop();
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
    blobRef.current = null;
    setFailure(null);
    setPhase("scan");
    setCameraReady(false);
    setEngineReady(false);
    setReason("align");
    setStable(0);
    setDistanceHint(false);
    setSession((value) => value + 1);
  }

  function save() {
    const canvas = previewRef.current;
    if (!canvas || canvas.width < 2) return;
    const download = (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
      link.download = `id-card-${stamp}.jpg`;
      link.click();
      URL.revokeObjectURL(url);
    };
    if (blobRef.current) {
      download(blobRef.current);
      return;
    }
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        blobRef.current = blob;
        download(blob);
      },
      "image/jpeg",
      0.95,
    );
  }

  const ready = cameraReady && engineReady;
  const guide = view.w > 0 ? guideRect(view.w, view.h, guideFraction) : null;
  const tone = toneFor(reason, ready);
  const statusText = !cameraReady
    ? "카메라를 켜고 있습니다"
    : !engineReady
      ? "인식 엔진을 준비하고 있습니다"
      : reason === "blur" && distanceHint
        ? "휴대폰을 조금 멀리해 주세요"
        : STATUS[reason];

  return (
    <main className="scanner" data-tone={tone}>
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
          <h1>신분증 촬영</h1>
          <p className="instructions">신분증을 책상 위에 놓아 주세요.<br />사진은 자동으로 찍힙니다.</p>
        </div>
        <div className="bottom">
          <p className="status" role="status">
            {statusText}
          </p>
          {ready && (
            <div className="bars" aria-hidden="true">
              {Array.from({ length: LIMITS.stableFrames }, (_, index) => (
                <span key={index} className={index < stable ? "bar on" : "bar"} />
              ))}
            </div>
          )}
        </div>
      </div>

      <section className="result" hidden={phase !== "result" || failure != null}>
        <h1>사진이 찍혔습니다</h1>
        <canvas ref={previewRef} className="preview" aria-label="잘라낸 신분증" />
        <p>이 기기에만 있습니다. 서버로 보내지 않습니다.</p>
        <div className="actions">
          <button type="button" onClick={() => controlsRef.current?.retake()}>
            다시 촬영
          </button>
          <button type="button" className="primary" onClick={save}>
            사진 저장
          </button>
        </div>
      </section>

      <section className="error-view" hidden={failure == null}>
        <h1>촬영을 시작하지 못했습니다</h1>
        <p>{failure ? FAILURE_TEXT[failure] : ""}</p>
        <button type="button" className="primary" onClick={retry}>
          다시 시도
        </button>
      </section>

      {flash > 0 && phase === "result" && <div key={flash} className="flash" />}
    </main>
  );
}
