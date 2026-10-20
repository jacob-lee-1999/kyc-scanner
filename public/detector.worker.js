self.Module = {
  onRuntimeInitialized() {
    const api = self.Module;
    if (api && typeof api.then === "function") delete api.then;
    self.cvApi = api;
    self.postMessage({ type: "ready" });
  },
};

importScripts("./detector-core.js?v=card-region-2", "./opencv.js");

self.onmessage = (event) => {
  const message = event.data;
  const cv = self.cvApi;
  if (!cv || !cv.Mat) {
    self.postMessage({ type: "error", message: "engine" });
    return;
  }
  try {
    if (message.type === "frame") {
      const started = performance.now();
      const metrics = self.detectorCore.analyzeScanFrame(
        cv,
        {
          data: new Uint8Array(message.edge.buffer),
          width: message.edge.width,
          height: message.edge.height,
        },
        {
          data: new Uint8Array(message.source.buffer),
          width: message.source.width,
          height: message.source.height,
        },
      );
      self.postMessage({ type: "metrics", frameId: message.frameId, ms: performance.now() - started, ...metrics });
      return;
    }
    if (message.type === "crop") {
      const result = self.detectorCore.warpCard(
        cv,
        {
          data: new Uint8Array(message.buffer),
          width: message.width,
          height: message.height,
        },
        message.corners,
        message.outWidth,
        message.outHeight,
      );
      self.postMessage(
        {
          type: "result",
          width: result.width,
          height: result.height,
          buffer: result.data.buffer,
        },
        [result.data.buffer],
      );
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
