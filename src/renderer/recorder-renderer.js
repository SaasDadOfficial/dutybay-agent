window.recorderBridge.onStart(async ({ sourceId, durationMs }) => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 854,
          maxHeight: 480,
          maxFrameRate: 10
        }
      }
    });

    const chunks = [];
    const recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp8',
      videoBitsPerSecond: 250000 // ~250kbps -> a 20s clip lands around 500KB-1MB
    });

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: 'video/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      window.recorderBridge.sendDone(arrayBuffer);
    };

    recorder.start();
    setTimeout(() => recorder.stop(), durationMs);
  } catch (err) {
    window.recorderBridge.sendError(err.message || String(err));
  }
});