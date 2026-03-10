import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const MAT_WIDTH_M = 0.6;
const MAT_HEIGHT_M = 0.35;
const REQUIRED_IDS = [0, 1, 2, 3];
const ASSUMED_FOV_DEG = 60;
const MAX_SCAN_WIDTH = 960;
const ARUCO_DICT_NAME = "DICT_4X4_50";

const video = document.getElementById("camera");
const threeCanvas = document.getElementById("three-canvas");
const debugCanvas = document.getElementById("debug-canvas");
const statusEl = document.getElementById("status");
const qrStatusEl = document.getElementById("qr-status");
const startBtn = document.getElementById("start-btn");
const cameraSelect = document.getElementById("camera-select");

const scanCanvas = document.createElement("canvas");
const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });
const debugCtx = debugCanvas.getContext("2d");

const renderer = new THREE.WebGLRenderer({
  canvas: threeCanvas,
  alpha: true,
  antialias: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(ASSUMED_FOV_DEG, 1, 0.01, 20);
camera.matrixAutoUpdate = false;
camera.matrix.identity();
camera.matrixWorld.copy(camera.matrix);
camera.matrixWorldInverse.copy(camera.matrix);

const playmatAnchor = new THREE.Group();
playmatAnchor.matrixAutoUpdate = false;
playmatAnchor.visible = false;
scene.add(playmatAnchor);

const ambient = new THREE.AmbientLight(0xffffff, 1.0);
scene.add(ambient);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
keyLight.position.set(2, 2.5, -1.5);
scene.add(keyLight);

addFallbackModel(playmatAnchor);
loadOptionalModel(playmatAnchor);

const cvToThree = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, -1, 0, 0,
  0, 0, -1, 0,
  0, 0, 0, 1
);

let videoWidth = 0;
let videoHeight = 0;
let fx = 0;
let fy = 0;
let cx = 0;
let cy = 0;
let trackingReady = false;
let frameIndex = 0;
let lastFoundMarkers = [];
let animationStarted = false;
let currentStream = null;
let scanScale = 1;
let arucoDictionary = null;
let arucoParams = null;
let arucoApi = null;
let arucoDetector = null;

startBtn.addEventListener("click", async () => {
  await startOrRestartTracking();
});

window.addEventListener("error", (event) => {
  statusEl.textContent = `Erreur JS: ${event.message}`;
});

window.addEventListener("unhandledrejection", (event) => {
  statusEl.textContent = `Erreur async: ${String(event.reason?.message || event.reason || "inconnue")}`;
});

window.addEventListener("resize", () => {
  if (!trackingReady) return;
  layoutMedia();
});

cameraSelect.addEventListener("change", async () => {
  if (!currentStream) return;
  await startOrRestartTracking();
});

initializeCameraPicker();

async function initializeCameraPicker() {
  try {
    await populateCameraSelect();
    navigator.mediaDevices?.addEventListener?.("devicechange", () => {
      populateCameraSelect();
    });
  } catch {
    // Ignore device list failures before permissions are granted.
  }
}

async function startOrRestartTracking() {
  startBtn.disabled = true;
  statusEl.textContent = "Etat: ouverture camera...";

  try {
    ensureCameraPrerequisites();
    await waitForOpenCv();
    ensureArucoReady();
    await startCamera(cameraSelect.value || null);
    setupAfterVideoReady();
    const count = await populateCameraSelect();
    statusEl.textContent = "Etat: tracking actif (en recherche des 4 ArUco)";
    if (count <= 1) {
      qrStatusEl.textContent = "Info camera: 1 seule camera detectee";
    }
    if (!animationStarted) {
      animationStarted = true;
      requestAnimationFrame(loop);
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Erreur: ${String(err?.message || err)}`;
  } finally {
    startBtn.disabled = false;
  }
}

function ensureCameraPrerequisites() {
  const localHostnames = new Set(["localhost", "127.0.0.1"]);
  const isLocal = localHostnames.has(window.location.hostname);
  if (!window.isSecureContext && !isLocal) {
    throw new Error("Camera bloquee: utilise https ou localhost.");
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("getUserMedia non supporte par ce navigateur.");
  }
}

function ensureArucoReady() {
  if (arucoApi && arucoDictionary) return;
  const cvApi = window.cv;
  arucoApi = resolveArucoApi(cvApi);

  const dictId = arucoApi.constants[ARUCO_DICT_NAME];
  if (typeof dictId === "undefined") {
    throw new Error(`Dictionnaire ArUco introuvable: ${ARUCO_DICT_NAME}.`);
  }

  arucoDictionary = arucoApi.getPredefinedDictionary(dictId);
  arucoParams = arucoApi.createDetectorParameters ? arucoApi.createDetectorParameters() : null;
  if (arucoApi.ArucoDetector) {
    arucoDetector = new arucoApi.ArucoDetector(arucoDictionary, arucoParams || undefined);
  }
}

function resolveArucoApi(cvApi) {
  const ns = cvApi?.aruco || cvApi;
  const constants = cvApi?.aruco || cvApi;
  const getPredefinedDictionary = ns?.getPredefinedDictionary || cvApi?.getPredefinedDictionary;
  const detectMarkers = ns?.detectMarkers || cvApi?.detectMarkers;
  const ArucoDetector = cvApi?.ArucoDetector || ns?.ArucoDetector || null;
  const createDetectorParameters =
    ns?.DetectorParameters?.create
    || cvApi?.DetectorParameters?.create
    || (cvApi?.aruco_DetectorParameters ? (() => new cvApi.aruco_DetectorParameters()) : null)
    || (cvApi?.DetectorParameters ? (() => new cvApi.DetectorParameters()) : null);

  if (typeof getPredefinedDictionary !== "function") {
    throw new Error("ArUco indisponible: getPredefinedDictionary manquant dans cette build OpenCV.js.");
  }
  if (typeof detectMarkers !== "function" && !ArucoDetector) {
    throw new Error("ArUco indisponible: detectMarkers/ArucoDetector manquant.");
  }

  return {
    constants,
    getPredefinedDictionary,
    detectMarkers,
    createDetectorParameters,
    ArucoDetector,
  };
}

async function waitForOpenCv() {
  if (window.cv && window.cv.Mat) return;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("OpenCV non charge (timeout).")), 15000);
    let settled = false;

    const done = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
    };

    const check = () => {
      if (window.cv && window.cv.Mat) {
        done();
      } else {
        setTimeout(check, 100);
      }
    };

    if (window.cv) {
      const previous = window.cv.onRuntimeInitialized;
      window.cv.onRuntimeInitialized = () => {
        if (typeof previous === "function") previous();
        done();
      };
    }

    check();
  });
}

async function startCamera(deviceId) {
  if (currentStream) {
    for (const track of currentStream.getTracks()) track.stop();
  }

  const preferred = deviceId
    ? {
      deviceId: { exact: deviceId },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    }
    : {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: preferred,
      audio: false,
    });
  } catch (err) {
    // Mobile browsers sometimes reject strict constraints on first try.
    stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
    statusEl.textContent = "Etat: camera ouverte (mode compatibilite mobile)";
  }
  currentStream = stream;
  video.srcObject = stream;

  await new Promise((resolve) => {
    video.onloadedmetadata = () => resolve();
  });
  await video.play();
}

async function populateCameraSelect() {
  const previousValue = cameraSelect.value;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === "videoinput");

  cameraSelect.innerHTML = "";
  const autoOption = document.createElement("option");
  autoOption.value = "";
  autoOption.textContent = "Camera par defaut";
  cameraSelect.appendChild(autoOption);

  if (cameras.length === 0) {
    return 0;
  }

  cameras.forEach((cam, index) => {
    const option = document.createElement("option");
    option.value = cam.deviceId;
    option.textContent = cam.label || `Camera ${index + 1}`;
    cameraSelect.appendChild(option);
  });

  const hasPrevious = cameras.some((c) => c.deviceId === previousValue);
  if (hasPrevious) {
    cameraSelect.value = previousValue;
  } else if (currentStream) {
    const activeTrack = currentStream.getVideoTracks()[0];
    const activeId = activeTrack?.getSettings()?.deviceId;
    if (activeId && cameras.some((c) => c.deviceId === activeId)) {
      cameraSelect.value = activeId;
    }
  }

  return cameras.length;
}

function setupAfterVideoReady() {
  videoWidth = video.videoWidth;
  videoHeight = video.videoHeight;

  const targetScanWidth = Math.min(videoWidth, MAX_SCAN_WIDTH);
  scanScale = targetScanWidth / videoWidth;
  scanCanvas.width = Math.max(1, Math.round(videoWidth * scanScale));
  scanCanvas.height = Math.max(1, Math.round(videoHeight * scanScale));
  debugCanvas.width = videoWidth;
  debugCanvas.height = videoHeight;

  const fovRad = (ASSUMED_FOV_DEG * Math.PI) / 180;
  fx = (videoWidth * 0.5) / Math.tan(fovRad * 0.5);
  fy = fx;
  cx = videoWidth * 0.5;
  cy = videoHeight * 0.5;

  updateProjectionFromIntrinsics(camera, fx, fy, cx, cy, videoWidth, videoHeight, 0.01, 20);
  layoutMedia();
  trackingReady = true;
}

function layoutMedia() {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const streamAspect = videoWidth / videoHeight;
  const viewportAspect = viewportW / viewportH;

  let displayW = viewportW;
  let displayH = viewportH;

  if (viewportAspect > streamAspect) {
    displayH = viewportH;
    displayW = displayH * streamAspect;
  } else {
    displayW = viewportW;
    displayH = displayW / streamAspect;
  }

  const left = (viewportW - displayW) * 0.5;
  const top = (viewportH - displayH) * 0.5;

  for (const el of [video, threeCanvas, debugCanvas]) {
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${displayW}px`;
    el.style.height = `${displayH}px`;
  }

  renderer.setSize(displayW, displayH, false);
}

function loop() {
  if (!trackingReady) return;

  frameIndex += 1;
  scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
  const imageData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
  if (frameIndex % 2 === 0) {
    lastFoundMarkers = detectArucoMarkers(imageData, scanScale);
    drawDebug(lastFoundMarkers);
    const pose = estimatePoseFromMarkers(lastFoundMarkers);
    applyPose(pose);
  }

  const ids = lastFoundMarkers.map((f) => f.id).sort((a, b) => a - b).join(", ");
  qrStatusEl.textContent = `ArUco detectes: ${ids || "aucun"}`;

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

function detectArucoMarkers(imageData, scale) {
  const cvApi = window.cv;
  const out = [];

  const rgba = cvApi.matFromImageData(imageData);
  const gray = new cvApi.Mat();
  cvApi.cvtColor(rgba, gray, cvApi.COLOR_RGBA2GRAY);

  const corners = new cvApi.MatVector();
  const ids = new cvApi.Mat();
  const rejected = new cvApi.MatVector();
  if (arucoDetector && typeof arucoDetector.detectMarkers === "function") {
    arucoDetector.detectMarkers(gray, corners, ids, rejected);
  } else {
    try {
      arucoApi.detectMarkers(gray, arucoDictionary, corners, ids, arucoParams || undefined, rejected);
    } catch {
      arucoApi.detectMarkers(gray, arucoDictionary, corners, ids);
    }
  }

  for (let i = 0; i < ids.rows; i += 1) {
    const markerId = typeof ids.intAt === "function" ? ids.intAt(i, 0) : ids.data32S[i];
    if (!REQUIRED_IDS.includes(markerId)) continue;

    const markerCorners = corners.get(i);
    const p = markerCorners.data32F;
    const scaledLocation = {
      topLeftCorner: { x: p[0], y: p[1] },
      topRightCorner: { x: p[2], y: p[3] },
      bottomRightCorner: { x: p[4], y: p[5] },
      bottomLeftCorner: { x: p[6], y: p[7] },
    };
    const originalLocation = scaleQrLocation(scaledLocation, scale);
    out.push({
      id: markerId,
      center: averageCorners(originalLocation),
      location: originalLocation,
    });
    markerCorners.delete();
  }

  rgba.delete();
  gray.delete();
  corners.delete();
  ids.delete();
  rejected.delete();

  return out;
}

function scaleQrLocation(location, scale) {
  if (scale === 1) return location;
  const inv = 1 / scale;
  return {
    topLeftCorner: { x: location.topLeftCorner.x * inv, y: location.topLeftCorner.y * inv },
    topRightCorner: { x: location.topRightCorner.x * inv, y: location.topRightCorner.y * inv },
    bottomRightCorner: { x: location.bottomRightCorner.x * inv, y: location.bottomRightCorner.y * inv },
    bottomLeftCorner: { x: location.bottomLeftCorner.x * inv, y: location.bottomLeftCorner.y * inv },
  };
}

function averageCorners(location) {
  const pts = [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner,
  ];
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

function estimatePoseFromMarkers(foundMarkers) {
  const cvApi = window.cv;
  const pointsById = new Map(foundMarkers.map((m) => [m.id, m.center]));
  if (!REQUIRED_IDS.every((id) => pointsById.has(id))) return null;

  const imagePts = REQUIRED_IDS.map((id) => pointsById.get(id));
  const worldPts = [
    { x: 0, y: 0, z: 0 },
    { x: MAT_WIDTH_M, y: 0, z: 0 },
    { x: MAT_WIDTH_M, y: MAT_HEIGHT_M, z: 0 },
    { x: 0, y: MAT_HEIGHT_M, z: 0 },
  ];

  const objectPoints = cvApi.matFromArray(
    4,
    1,
    cvApi.CV_32FC3,
    worldPts.flatMap((p) => [p.x, p.y, p.z])
  );
  const imagePoints = cvApi.matFromArray(
    4,
    1,
    cvApi.CV_32FC2,
    imagePts.flatMap((p) => [p.x, p.y])
  );
  const cameraMatrix = cvApi.matFromArray(
    3,
    3,
    cvApi.CV_64FC1,
    [fx, 0, cx, 0, fy, cy, 0, 0, 1]
  );
  const distCoeffs = cvApi.Mat.zeros(4, 1, cvApi.CV_64FC1);
  const rvec = new cvApi.Mat();
  const tvec = new cvApi.Mat();

  const ok = cvApi.solvePnP(
    objectPoints,
    imagePoints,
    cameraMatrix,
    distCoeffs,
    rvec,
    tvec,
    false,
    cvApi.SOLVEPNP_ITERATIVE
  );

  objectPoints.delete();
  imagePoints.delete();
  cameraMatrix.delete();
  distCoeffs.delete();

  if (!ok) {
    rvec.delete();
    tvec.delete();
    return null;
  }

  const rmat = new cvApi.Mat();
  cvApi.Rodrigues(rvec, rmat);

  const mCv = new THREE.Matrix4().set(
    rmat.doubleAt(0, 0), rmat.doubleAt(0, 1), rmat.doubleAt(0, 2), tvec.doubleAt(0, 0),
    rmat.doubleAt(1, 0), rmat.doubleAt(1, 1), rmat.doubleAt(1, 2), tvec.doubleAt(1, 0),
    rmat.doubleAt(2, 0), rmat.doubleAt(2, 1), rmat.doubleAt(2, 2), tvec.doubleAt(2, 0),
    0, 0, 0, 1
  );

  rvec.delete();
  tvec.delete();
  rmat.delete();

  return cvToThree.clone().multiply(mCv);
}

function applyPose(matrixWorldToCamera) {
  if (!matrixWorldToCamera) {
    playmatAnchor.visible = false;
    return;
  }
  playmatAnchor.visible = true;
  playmatAnchor.matrix.copy(matrixWorldToCamera);
}

function drawDebug(found) {
  debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
  debugCtx.lineWidth = 3;
  debugCtx.font = "24px sans-serif";

  for (const marker of found) {
    const l = marker.location;
    debugCtx.strokeStyle = "#00f2ff";
    debugCtx.beginPath();
    debugCtx.moveTo(l.topLeftCorner.x, l.topLeftCorner.y);
    debugCtx.lineTo(l.topRightCorner.x, l.topRightCorner.y);
    debugCtx.lineTo(l.bottomRightCorner.x, l.bottomRightCorner.y);
    debugCtx.lineTo(l.bottomLeftCorner.x, l.bottomLeftCorner.y);
    debugCtx.closePath();
    debugCtx.stroke();

    debugCtx.fillStyle = "#ffdb00";
    debugCtx.fillText(marker.id, marker.center.x + 8, marker.center.y - 8);
  }
}

function updateProjectionFromIntrinsics(cam, fxVal, fyVal, cxVal, cyVal, width, height, near, far) {
  const m11 = (2 * fxVal) / width;
  const m22 = (2 * fyVal) / height;
  const m13 = 1 - (2 * cxVal) / width;
  const m23 = (2 * cyVal) / height - 1;
  const m33 = -(far + near) / (far - near);
  const m34 = (-2 * far * near) / (far - near);

  cam.projectionMatrix.set(
    m11, 0, m13, 0,
    0, m22, m23, 0,
    0, 0, m33, m34,
    0, 0, -1, 0
  );
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
}

function addFallbackModel(parent) {
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 32, 16),
    new THREE.MeshStandardMaterial({ color: 0xffd447, roughness: 0.45, metalness: 0.05 })
  );
  body.position.set(MAT_WIDTH_M * 0.5, MAT_HEIGHT_M * 0.5, 0.05);
  parent.add(body);

  const ears = new THREE.Mesh(
    new THREE.ConeGeometry(0.011, 0.03, 10),
    new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.6 })
  );
  ears.position.set(MAT_WIDTH_M * 0.5 + 0.02, MAT_HEIGHT_M * 0.5 + 0.015, 0.09);
  ears.rotation.x = Math.PI * 0.2;
  parent.add(ears);

  const ears2 = ears.clone();
  ears2.position.x -= 0.04;
  parent.add(ears2);
}

function loadOptionalModel(parent) {
  const loader = new GLTFLoader();
  loader.load(
    "./assets/pokemon.glb",
    (gltf) => {
      const model = gltf.scene;
      model.scale.setScalar(0.06);
      model.position.set(MAT_WIDTH_M * 0.5, MAT_HEIGHT_M * 0.5, 0.02);
      parent.add(model);
      statusEl.textContent = "Etat: modele GLB charge + tracking actif";
    },
    undefined,
    () => {}
  );
}
