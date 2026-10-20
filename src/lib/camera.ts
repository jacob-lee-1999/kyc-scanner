export type CameraFailure = "permission" | "missing" | "insecure" | "unsupported" | "busy" | "unknown";

const ATTEMPTS: MediaStreamConstraints[] = [
  {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 3840 },
      frameRate: { ideal: 15, max: 15 },
      height: { ideal: 2160 },
    },
  },
  {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  },
  { audio: false, video: { facingMode: "environment" } },
  { audio: false, video: true },
];

export function cameraFailure(error: unknown): CameraFailure {
  if (!(error instanceof DOMException)) return "unknown";
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") return "permission";
  if (error.name === "NotSupportedError") return "unsupported";
  if (error.name === "NotFoundError" || error.name === "OverconstrainedError") return "missing";
  if (error.name === "NotReadableError" || error.name === "TrackStartError") return "busy";
  if (error.name === "SecurityError") return "insecure";
  return "unknown";
}

type FocusRange = { min: number; max: number; step?: number };

type ExtraCaps = MediaTrackCapabilities & {
  focusMode?: string[];
  focusDistance?: FocusRange;
  exposureMode?: string[];
  whiteBalanceMode?: string[];
  zoom?: { min: number; max: number };
};

export function canFocusClose(caps: {
  focusMode?: string[];
  focusDistance?: { min: number; max: number };
} | undefined): boolean {
  const modes = caps?.focusMode ?? [];
  if (modes.includes("continuous") || modes.includes("single-shot")) return true;
  const range = caps?.focusDistance;
  return modes.includes("manual") && !!range && range.min > 0 && range.max > range.min;
}

// Largest focusing back camera. A fixed ultrawide or macro stays below that group.
export function mainLensScore(probe: { pixels: number; canFocus: boolean }): number {
  const pixels = Number.isFinite(probe.pixels) && probe.pixels > 0 ? probe.pixels : 0;
  return (probe.canFocus ? 1_000_000_000 : 0) + pixels;
}

// Zoom below 1 is the ultrawide on a combined camera. 1 is the main wide lens.
export function mainZoom(zoom: { min: number; max: number } | undefined): number | null {
  if (!zoom || !(zoom.min < 1) || !(zoom.max >= 1)) return null;
  return 1;
}

// Meters. 0 is infinity. The closest plane is the smallest positive value.
// A step inside the stop: some cameras reject the exact minimum.
export function closestFocusDistance(range: FocusRange | undefined): number | null {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || !(range.max > 0)) return null;
  const step = range.step && range.step > 0 ? range.step : 0.01;
  const near = Math.round((range.min > 0 ? range.min + step : step) * 1000) / 1000;
  if (near < range.max) return near;
  return range.min > 0 ? range.min : null;
}

function capsOf(track: MediaStreamTrack): ExtraCaps | undefined {
  return track.getCapabilities?.() as ExtraCaps | undefined;
}

function lensScore(track: MediaStreamTrack): number {
  const caps = capsOf(track);
  const width = caps?.width?.max ?? 0;
  const height = caps?.height?.max ?? 0;
  return mainLensScore({ pixels: width * height, canFocus: canFocusClose(caps) });
}

function isBackCamera(track: MediaStreamTrack, label: string): boolean {
  const facing = track.getSettings?.().facingMode;
  if (facing === "environment") return true;
  if (facing === "user") return false;
  return /back|rear|environment/i.test(label) && !/front|user/i.test(label);
}

async function preferMainBackCamera(current: MediaStream): Promise<MediaStream> {
  if (!navigator.mediaDevices?.enumerateDevices) return current;
  const currentTrack = current.getVideoTracks()[0];
  if (!currentTrack) return current;
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  } catch {
    return current;
  }
  if (devices.length < 2) return current;
  const fallbackId = currentTrack.getSettings().deviceId;
  current.getTracks().forEach((track) => track.stop());
  await new Promise((resolve) => setTimeout(resolve, 150));

  let bestId = "";
  let bestScore = -1;
  for (const device of devices) {
    if (/front|user/i.test(device.label) && !/back|rear|environment/i.test(device.label)) continue;
    let trial: MediaStream;
    try {
      trial = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: device.deviceId } },
      });
    } catch {
      continue;
    }
    const track = trial.getVideoTracks()[0];
    const score = track && isBackCamera(track, device.label) ? lensScore(track) : -1;
    trial.getTracks().forEach((item) => item.stop());
    if (score > bestScore) {
      bestId = device.deviceId;
      bestScore = score;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (bestId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: bestId },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 15, max: 15 },
        },
      });
    } catch (error) {
      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) throw error;
      return navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: bestId }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    }
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: fallbackId ? { deviceId: { exact: fallbackId } } : { facingMode: "environment" },
    });
  } catch {
    return openFirstCamera();
  }
}

async function openFirstCamera(): Promise<MediaStream> {
  let last: unknown;
  for (const constraints of ATTEMPTS) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      last = error;
      if (
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError")
      ) {
        throw error;
      }
    }
  }
  throw last instanceof Error ? last : new DOMException("Camera failed", "NotFoundError");
}

export async function openCamera(): Promise<MediaStream> {
  if (typeof window === "undefined" || !window.isSecureContext) {
    throw new DOMException("Camera requires a secure context", "SecurityError");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException("Camera API is missing", "NotSupportedError");
  }
  return preferMainBackCamera(await openFirstCamera());
}

async function applyMode(track: MediaStreamTrack, advanced: MediaTrackConstraintSet) {
  await track.applyConstraints({ advanced: [advanced] });
}

export async function tuneTrack(track: MediaStreamTrack) {
  const caps = capsOf(track);
  const modes: Array<[string, string[] | undefined]> = [
    ["exposureMode", caps?.exposureMode],
    ["whiteBalanceMode", caps?.whiteBalanceMode],
  ];
  for (const [key, supported] of modes) {
    if (!supported?.includes("continuous")) continue;
    try {
      await applyMode(track, { [key]: "continuous" } as MediaTrackConstraintSet);
    } catch {
      // The camera keeps the settings it already accepted.
    }
  }
  const zoom = mainZoom(caps?.zoom);
  if (zoom != null) {
    try {
      await applyMode(track, { zoom } as MediaTrackConstraintSet);
    } catch {
      // The camera stays on whichever lens it already selected.
    }
  }
  await focusClose(track);
  if ("contentHint" in track) track.contentHint = "text";
}

// Keep autofocus enabled; the nearest supported distance is not the card distance.
async function focusClose(track: MediaStreamTrack) {
  const modes = capsOf(track)?.focusMode ?? [];
  for (const focusMode of ["continuous", "single-shot"]) {
    if (!modes.includes(focusMode)) continue;
    try {
      await applyMode(track, { focusMode } as MediaTrackConstraintSet);
      return;
    } catch {
      // Try the next supported mode, otherwise retain browser defaults.
    }
  }
}

export async function refocus(track: MediaStreamTrack) {
  await focusClose(track);
}
