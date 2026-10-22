"use client";

import { useEffect, useRef, useState } from "react";
import {
  cameraFailure,
  dimForGlare,
  openCamera,
  refocus,
  tuneTrack,
  type CameraFailure,
} from "@/lib/camera";
import {
  EMPTY_STABILITY,
  evaluateFrame,
  LIMITS,
  type Damage,
  type Reason,
  type Stability,
} from "@/lib/decide";
import {
  analysisSource,
  coverMap,
  drawable,
  clampRect,
  edgeSize,
  guideRect,
  GUIDE_PAD,
  relativeInner,
  outputSize,
  stageRectToVideo,
  type Point,
  type Rect,
} from "@/lib/geometry";

import { CANDIDATE_MAX_AGE_MS, CAPTURE_MARGIN, coveringFrames, documentKind, glareCovered, KIND_ASPECT, KIND_FRAMES, paddedCapture, preferCandidate, type DocumentKind } from "@/lib/capture";

const FRAME_GAP_MS = 120;
// A rejected card must be out of view this long before auto capture resumes.
const DAMAGE_CLEAR_MS = 1000;
// Glare must last this long before exposure is lowered, so a passing reflection does not.
const GLARE_DIM_MS = 600;
// Gallery photos are scaled down to this long side; enough for the saved card.
const PHOTO_MAX = 2400;
// Room around the photo for the capture margin, filled by stretching its edge pixels.
const PHOTO_PAD = 0.08;
// Focal length of a phone main lens (about 26mm equivalent) over the short side of
// its frame; the A53 main lens is 1.25.
const LENS_FOCAL = 1.2;
const PHOTO_MISSED = "사진에서 신분증을 찾지 못했습니다. 신분증 전체와 주변이 보이는 사진을 골라 주세요";

type Failure = CameraFailure | "engine";
type Crop = NonNullable<ReturnType<typeof paddedCapture>>;
// Recent frames of the card, kept to fill in its glare at capture (fuseGlare).
type Recent = { at: number; frameId: number; cells: number[]; crop: Crop; canvas: HTMLCanvasElement };
const RECENT_FRAMES = 4;
type Phase = "scan" | "result";
type Plan = {
  snapshot: Rect;
  source: Rect;
  inner: Rect;
  qualitySize: { width: number; height: number };
  edge: { width: number; height: number };
  // Principal point and focal length of the camera, in units of source width.
  lens: { x: number; y: number; f: number };
};
const STATUS: Record<Reason, string> = {
  align: "신분증 전체가 보이게 화면 가운데 놓아 주세요",
  closer: "휴대폰을 조금 가까이해 주세요",
  glare: "휴대폰을 옆으로 조금 기울여 주세요",
  dark: "너무 어둡습니다. 밝은 곳으로 옮겨 주세요",
  bright: "너무 밝아 글자가 날아갑니다. 각도를 바꿔 주세요",
  blur: "초점이 맞지 않습니다. 잠시 그대로 있어 주세요",
  move: "흔들렸습니다. 신분증을 고정해 주세요",
  hold: "선명합니다. 그대로 있어 주세요",
  ok: "촬영합니다",
  corner: "모서리가 깨진 신분증은 사용할 수 없습니다",
  split: "쪼개졌다 붙인 신분증은 사용할 수 없습니다",
  hole: "구멍 난 신분증은 사용할 수 없습니다",
  covered: "손가락을 치워 주세요",
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
  const visible = stageRectToVideo({x:0,y:0,width:view.w,height:view.h}, coverMap(view.w, view.h, video.videoWidth, video.videoHeight));
  const analyzed = analysisSource(guide, GUIDE_PAD, video.videoWidth, video.videoHeight);
  const source = drawable(clampRect(analyzed.source, visible), video.videoWidth, video.videoHeight);
  if (!source) return null;
  const inner = relativeInner(guide, source);
  const snapshot = drawable(analysisSource(source, 0.12, video.videoWidth, video.videoHeight).source, video.videoWidth, video.videoHeight);
  if (!snapshot) return null;
  const local = (rect: Rect): Rect => ({ ...rect, x: rect.x - snapshot.x, y: rect.y - snapshot.y });
  const qualityScale = Math.min(1, 1280 / source.width, 960 / source.height);
  return { snapshot, source: local(source), inner, qualitySize: {
    width: Math.round(source.width * qualityScale), height: Math.round(source.height * qualityScale),
  }, edge: edgeSize(source), lens: {
    x: (video.videoWidth / 2 - source.x) / source.width,
    y: (video.videoHeight / 2 - source.y) / source.width,
    f: (LENS_FOCAL * Math.min(video.videoWidth, video.videoHeight)) / source.width,
  } };
}

function toneFor(reason: Reason, ready: boolean): "idle" | "warn" | "ready" {
  if (!ready) return "idle";
  if (reason === "hold" || reason === "ok") return "ready";
  if (reason === "closer" || reason === "glare" || reason === "dark" || reason === "bright" || reason === "blur") return "warn";
  if (reason === "corner" || reason === "split" || reason === "hole" || reason === "covered") return "warn";
  return "idle";
}

export default function Scanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const blobRef = useRef<Blob | null>(null);
  const controlsRef = useRef<{ retake: () => void; pickPhoto: () => boolean; loadPhoto: (file: File) => void; resume: () => void } | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
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
  const [detected, setDetected] = useState<Point[] | null>(null);
  const [stable, setStable] = useState(0);
  const [flash, setFlash] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [guideFraction] = useState(0.72);

  useEffect(() => {
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let mode: "scan" | "photo" | "capturing" | "result" | "error" = "scan";
    let fromPhoto = false;
    let busy = false;
    let engineReadyNow = false;
    // A photo picked before the engine is up waits here for it.
    let queuedPhoto: (() => void) | null = null;
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
    let rejected: Damage | null = null;
    let clearSince = 0;
    let dimmed = false;
    let glareSince = 0;
    let goneSince = 0;
    const bestCanvas = document.createElement("canvas");
    let best: { score: number; at: number; frameId: number; crop: Crop; cells: number[] | null; kind: DocumentKind } | null = null;
    // Passport zone (or none) seen on each recent frame of the card.
    let zones: (string | null)[] = [];
    const recentCanvases = Array.from({ length: RECENT_FRAMES }, () => document.createElement("canvas"));
    let recent: Recent[] = [];
    const snapshot = document.createElement("canvas");
    const photo = document.createElement("canvas");
    const planRef: { current: Plan | null } = { current: null };
    const edgeCanvas = document.createElement("canvas");
    const sourceCanvas = document.createElement("canvas");
    const worker = new Worker(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/detector.worker.js?v=card-shape-2`);


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
          const sourcePixels = drawRegion(
            snapshot,
            sourceCanvas,
            plan.source,
            plan.qualitySize.width,
            plan.qualitySize.height,
          );
          if (edge && sourcePixels) {
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
                source: {
                  buffer: sourcePixels.buffer,
                  width: plan.qualitySize.width,
                  height: plan.qualitySize.height,
                },
                inner: plan.inner,
                lens: plan.lens,
              },
              [edge.buffer, sourcePixels.buffer],
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
      const frameId = best.frameId;
      const extras = (best.cells ? coveringFrames(best.cells, recent.filter(f => f.frameId !== frameId)) : []).map(f => {
        const image = f.canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, f.canvas.width, f.canvas.height);
        return { buffer: image.data.buffer, width: image.width, height: image.height, corners: f.crop.corners };
      });
      busyTimer = window.setTimeout(() => fail("engine"), 5000);
      worker.postMessage({ type: "crop", buffer: pixels.data.buffer,
        width: bestCanvas.width, height: bestCanvas.height, corners,
        outWidth: size.width, outHeight: size.height, margin: CAPTURE_MARGIN, extras, kind: best.kind },
        [pixels.data.buffer, ...extras.map(e => e.buffer)]);
    };
    const photoMissed = () => {
      mode = "scan";
      fromPhoto = false;
      setNotice(PHOTO_MISSED);
      startLoop();
    };
    const showReason = (next: Reason) => {
      shownAt = performance.now();
      reasonRef.current = next;
      setReason(next);
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
        glare?: number[] | null;
        damage?: Damage | null;
        outline?: boolean;
        mrz?: string | null;
      };
      if (data.type === "ready") {
        engineReadyNow = true;
        setEngineReady(true);
        queuedPhoto?.();
        queuedPhoto = null;
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
        window.clearTimeout(busyTimer);
        // Refuse a damaged card, and quietly drop a capture whose outline could not
        // be found (it is likely cropped); keep scanning, the preview never stopped.
        if (data.damage || data.outline === false) {
          mode = "scan";
          stability = { ...EMPTY_STABILITY };
          best = null;
          recent = [];
          zones = [];
          // A rejected photo does not hold back the camera; only a card in view does.
          if (fromPhoto) setNotice(data.damage ? STATUS[data.damage] : PHOTO_MISSED);
          else if (data.damage && data.damage !== "covered") {
            rejected = data.damage;
            clearSince = 0;
          }
          showReason(data.damage ?? "align");
          stableRef.current = 0;
          setStable(0);
          fromPhoto = false;
          startLoop();
          return;
        }
        fromPhoto = false;
        setNotice(null);
        setFlash(value => value + 1);
        navigator.vibrate?.(30);
        const track = stream?.getVideoTracks()[0];
        if (track) track.enabled = false;
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
      if (data.type === "metrics" && mode === "photo" && data.frameId === pendingFrameId) {
        window.clearTimeout(busyTimer);
        // The photo was sent whole, so the quad is relative to the padded photo.
        const kind: DocumentKind = data.mrz === "TD3" ? "passport" : "card";
        const corners = data.quad?.map(p => ({ x: p.x * photo.width, y: p.y * photo.height }));
        const crop = corners && paddedCapture(corners, photo.width, photo.height, KIND_ASPECT[kind]);
        const ctx = bestCanvas.getContext("2d");
        if (!crop || !ctx) { photoMissed(); return; }
        bestCanvas.width = crop.source.width;
        bestCanvas.height = crop.source.height;
        ctx.drawImage(photo, crop.source.x, crop.source.y, crop.source.width, crop.source.height, 0, 0, bestCanvas.width, bestCanvas.height);
        best = { score: 0, at: 0, frameId: pendingFrameId, crop, cells: null, kind };
        fromPhoto = true;
        capture();
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
        setDetected(null);
        return;
      }
      const nativeCorners = data.quad?.map(p => ({x:p.x*plan.source.width,y:p.y*plan.source.height}));
      recent = recent.filter(f => sampledAt - f.at <= CANDIDATE_MAX_AGE_MS);
      const decision = evaluateFrame(stability, {
        cardWidth: nativeCorners ? outputSize(nativeCorners).width : undefined,
        sharpness: data.sharpness,
        glareRatio: data.glareRatio ?? 1,
        hotspot: data.hotspot ?? true,
        luma: data.luma ?? 0,
        borderScore: data.borderScore ?? 0,
        quad: data.quad ?? null,
        aspect: data.aspect ?? null,
        glareCovered: glareCovered(data.glare ?? null, recent),
      }, plan.inner, sampledAt);
      // A frame left out of a steady run changes nothing on screen or in the run.
      if (decision.state.skipped) {
        stability = decision.state;
        return;
      }
      const map = coverMap(viewRef.current.w, viewRef.current.h, video.videoWidth, video.videoHeight);
      setDetected(decision.quad?.map(p => ({
        x: ((plan.snapshot.x + plan.source.x + p.x * plan.source.width) * map.scale + map.offsetX) / viewRef.current.w * 100,
        y: ((plan.snapshot.y + plan.source.y + p.y * plan.source.height) * map.scale + map.offsetY) / viewRef.current.h * 100,
      })) ?? null);
      // Lower exposure while glare persists; restore once the card leaves or the view turns dark.
      const seen = performance.now();
      glareSince = decision.reason === "glare" ? glareSince || seen : 0;
      goneSince = decision.reason === "align" ? goneSince || seen : 0;
      const cameraTrack = stream?.getVideoTracks()[0];
      if (cameraTrack && !dimmed && glareSince && seen - glareSince >= GLARE_DIM_MS) {
        dimmed = true;
        void dimForGlare(cameraTrack, true);
      } else if (cameraTrack && dimmed && (decision.reason === "dark" || (goneSince && seen - goneSince >= DAMAGE_CLEAR_MS))) {
        dimmed = false;
        void dimForGlare(cameraTrack, false);
      }
      if (rejected) {
        // Keep the damage notice until the card leaves the view; no auto capture.
        const now = performance.now();
        if (decision.reason !== "align") clearSince = 0;
        else if (!clearSince) clearSince = now;
        if (clearSince && now - clearSince >= DAMAGE_CLEAR_MS) {
          rejected = null;
        } else {
          stability = { ...EMPTY_STABILITY };
          best = null;
          stableRef.current = 0;
          setStable(0);
          return;
        }
      }
      if (decision.state.count === 1 || (decision.reason !== "hold" && !decision.capture)) best = null;
      stability = decision.state;
      if (decision.reason === "align" || decision.reason === "move") recent = [];
      if (decision.reason === "align") zones = [];
      else if (decision.quad) zones = [...zones, data.mrz ?? null].slice(-KIND_FRAMES);
      const kind = documentKind(zones);
      const steady = decision.reason === "hold" || decision.capture;
      // Glare frames are kept too: a reflection elsewhere on the card fills in this one.
      if ((steady || decision.reason === "glare") && decision.quad) {
        const corners = decision.quad.map(p => ({ x: plan.source.x + p.x * plan.source.width, y: plan.source.y + p.y * plan.source.height }));
        const crop = paddedCapture(corners, snapshot.width, snapshot.height, KIND_ASPECT[kind]);
        if (!crop) {
          best = null;
          recent = [];
          stability = { ...EMPTY_STABILITY };
          reasonRef.current = "align";
          setReason("align");
          setStable(0);
          return;
        }
        if (data.glare) {
          const canvas = recentCanvases.find(c => !recent.some(f => f.canvas === c)) ?? recent.shift()!.canvas;
          canvas.width = crop.source.width;
          canvas.height = crop.source.height;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) { fail("engine"); return; }
          ctx.drawImage(snapshot, crop.source.x, crop.source.y, crop.source.width, crop.source.height, 0, 0, canvas.width, canvas.height);
          recent.push({ at: sampledAt, frameId: pendingFrameId, cells: data.glare, crop, canvas });
        }
        if (steady && preferCandidate(best, data.sharpness, sampledAt)) {
          bestCanvas.width = crop.source.width;
          bestCanvas.height = crop.source.height;
          const ctx = bestCanvas.getContext("2d");
          if (!ctx) { fail("engine"); return; }
          ctx.drawImage(snapshot, crop.source.x, crop.source.y, crop.source.width, crop.source.height, 0, 0, bestCanvas.width, bestCanvas.height);
          best = { score: data.sharpness, at: sampledAt, frameId: pendingFrameId, crop, cells: data.glare ?? null, kind };
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
        recent = [];
        zones = [];
        rejected = null;
        blurSince = 0;
        setDistanceHint(false);
        focusSettlesAt = performance.now() + 800;
        reasonRef.current = "align";
        stableRef.current = 0;
        blobRef.current = null;
        setReason("align");
        setDetected(null);
        setStable(0);
        setPhase("scan");
        const track = stream?.getVideoTracks()[0];
        if (track) track.enabled = true;
        void video.play().catch(() => undefined);
        startLoop();
      },
      // Stop the camera before the picker opens: the page is frozen while it is open,
      // and a frame timer running out meanwhile would report a broken engine.
      pickPhoto() {
        if (cancelled || mode !== "scan") return false;
        mode = "photo";
        stopLoop();
        // A camera frame still in the worker is dropped by its frameId.
        window.clearTimeout(busyTimer);
        busy = false;
        setDetected(null);
        return true;
      },
      resume() {
        if (cancelled || mode !== "photo") return;
        mode = "scan";
        startLoop();
      },
      async loadPhoto(file: File) {
        // A tap before the scanner was wired up opens the picker without stopping the camera.
        if (cancelled || (mode !== "photo" && !controlsRef.current?.pickPhoto())) return;
        setNotice("사진에서 신분증을 찾고 있습니다");
        let bitmap: ImageBitmap;
        try {
          bitmap = await createImageBitmap(file);
        } catch {
          if (!cancelled) photoMissed();
          return;
        }
        if (cancelled) { bitmap.close(); return; }
        const scale = Math.min(1, PHOTO_MAX / Math.max(bitmap.width, bitmap.height));
        const w = Math.round(bitmap.width * scale);
        const h = Math.round(bitmap.height * scale);
        const pad = Math.round(Math.max(w, h) * PHOTO_PAD);
        photo.width = w + 2 * pad;
        photo.height = h + 2 * pad;
        const ctx = photo.getContext("2d");
        if (!ctx) { bitmap.close(); fail("engine"); return; }
        // Draw the bitmap whole: Android Chrome reads a source rect of a rotated (EXIF)
        // photo in its unrotated size and leaves the rest of the photo blank.
        ctx.drawImage(bitmap, pad, pad, w, h);
        bitmap.close();
        // Stretch the outer pixel rows into the pad, so the pad adds no edge of its own.
        const cols = [[pad, 1, 0, pad], [pad, w, pad, w], [pad + w - 1, 1, pad + w, pad]];
        const rows = [[pad, 1, 0, pad], [pad, h, pad, h], [pad + h - 1, 1, pad + h, pad]];
        for (const [sx, sw, dx, dw] of cols) for (const [sy, sh, dy, dh] of rows) {
          if (dx !== pad || dy !== pad) ctx.drawImage(photo, sx, sy, sw, sh, dx, dy, dw, dh);
        }
        const whole: Rect = { x: 0, y: 0, width: photo.width, height: photo.height };
        const edge = edgeSize(whole);
        const qualityScale = Math.min(1, 1280 / whole.width, 960 / whole.height);
        const quality = { width: Math.round(whole.width * qualityScale), height: Math.round(whole.height * qualityScale) };
        const edgePixels = drawRegion(photo, edgeCanvas, whole, edge.width, edge.height);
        const sourcePixels = drawRegion(photo, sourceCanvas, whole, quality.width, quality.height);
        if (!edgePixels || !sourcePixels) { fail("engine"); return; }
        const send = () => {
          pendingFrameId = ++frameId;
          busyTimer = window.setTimeout(() => fail("engine"), 5000);
          worker.postMessage(
            {
              type: "frame",
              frameId: pendingFrameId,
              edge: { buffer: edgePixels.buffer, width: edge.width, height: edge.height },
              source: { buffer: sourcePixels.buffer, ...quality },
              lens: { x: 0.5, y: photo.height / photo.width / 2, f: (LENS_FOCAL * Math.min(w, h)) / photo.width },
            },
            [edgePixels.buffer, sourcePixels.buffer],
          );
        };
        if (engineReadyNow) send();
        else queuedPhoto = send;
      },
    };

    // Closing the picker without a photo brings the camera back.
    const photoInput = photoInputRef.current;
    const resumeScan = () => controlsRef.current?.resume();
    photoInput?.addEventListener("cancel", resumeScan);

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
      photoInput?.removeEventListener("cancel", resumeScan);
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
    setDetected(null);
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

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const ready = cameraReady && engineReady;
  const guide = view.w > 0 ? guideRect(view.w, view.h, guideFraction) : null;
  const tone = toneFor(reason, ready);
  const statusText = notice
    ? notice
    : !cameraReady
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
        {detected && (
          <svg className="detected-card" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polygon points={detected.map(p => `${p.x},${p.y}`).join(" ")} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        <div className="topbar">
          <h1>신분증 촬영</h1>
          <p className="instructions">신분증을 대략 가운데 놓아 주세요.<br />틀에 정확히 맞추지 않아도 됩니다.</p>
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
          {phase === "scan" && (
            <button type="button" className="photo" onClick={() => {
              // Open the picker even before the scanner is wired up; loadPhoto catches up.
              if (controlsRef.current?.pickPhoto() ?? true) photoInputRef.current?.click();
            }}>
              사진첩에서 불러오기
            </button>
          )}
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Clear it so picking the same photo again still fires.
              event.target.value = "";
              if (file) controlsRef.current?.loadPhoto(file);
              else controlsRef.current?.resume();
            }}
          />
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
