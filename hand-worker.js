/* Classic worker: the CJS browser bundle needs only the exports shim.
 * Keeping a classic worker also supports the MediaPipe WASM importScripts loader.
 * No camera frames are sent outside this worker/browser. */
let landmarker;
self.onmessage = async ({data}) => {
  if (data.type==='init') {
    try {
      self.exports={}; self.module={exports:self.exports};
      importScripts('./vendor/mediapipe-0.10.21.js');
      const {FilesetResolver,HandLandmarker} = self.module.exports;
      const files = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm');
      const options = {
        baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',delegate:'GPU'},
        runningMode:'VIDEO',numHands:1,
        minHandDetectionConfidence:.5,minHandPresenceConfidence:.5,minTrackingConfidence:.5,
      };
      try { landmarker=await HandLandmarker.createFromOptions(files,options); }
      catch { options.baseOptions.delegate='CPU'; landmarker=await HandLandmarker.createFromOptions(files,options); }
      self.postMessage({type:'ready'});
    } catch(error) { self.postMessage({type:'error',message:String(error.message||error)}); }
    return;
  }
  if (data.type==='frame') {
    try {
      const result=landmarker.detectForVideo(data.frame,data.timestamp);
      self.postMessage({type:'result',timestamp:data.timestamp,
        landmarks:result.landmarks[0]||null,world:result.worldLandmarks[0]||null,
        hand:result.handedness[0]?.[0]?.categoryName||''});
    } catch(error) { self.postMessage({type:'error',message:String(error.message||error)}); }
    finally { data.frame.close(); }
  }
};
