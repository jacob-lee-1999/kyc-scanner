self.Module = {
  onRuntimeInitialized() {
    const api = self.Module;
    if (api && typeof api.then === "function") delete api.then;
    self.cvApi = api;
    self.postMessage({ type: "ready" });
  },
};

importScripts("./reader-core.js?v=card-reader-6", "./digit-model.js?v=card-reader-6", "./opencv.js");

// Each frame is the camera's view of the guide; its numbers are read straight off
// it, with no card outline found first.
self.onmessage = (event) => {
  const message = event.data;
  const cv = self.cvApi;
  if (!cv || !cv.Mat) {
    self.postMessage({ type: "error", message: "engine" });
    return;
  }
  try {
    if (message.type === "frame") {
      const image = { data: new Uint8Array(message.buffer), width: message.width, height: message.height };
      const fields = self.readerCore.readFrame(cv, self.digitModel, image);
      self.postMessage({ type: "read", frameId: message.frameId, fields });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
