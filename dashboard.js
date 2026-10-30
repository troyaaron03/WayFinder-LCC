import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, serverTimestamp, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js";
import { defaultRoomCoordinates } from "./campus-locations.js";
import { linkStudentNumber } from "./student-account.js";

const firebaseConfig = {
  apiKey: "AIzaSyCDuxFyTm3pYIsrO5i5ivTKZyM4SZYnpqM",
  authDomain: "campus-navigation-system-4292f.firebaseapp.com",
  projectId: "campus-navigation-system-4292f",
  storageBucket: "campus-navigation-system-4292f.firebasestorage.app",
  messagingSenderId: "1007485437799",
  appId: "1:1007485437799:web:d157f9c9ac7ff46d2591c2",
  measurementId: "G-RT9C1JGB58"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
const $ = (id) => document.getElementById(id);
let currentUser = null;
let currentStudentNumber = "";
let currentRole = "";
let campusRooms = [];
let currentPosition = null;
let selectedMapRoomId = "";
let pendingArrivalRoomId = "";
const arrivalRecordedRoomIds = new Set();
let cameraStream = null;
let cameraHeading = null;
let cameraOrientationEnabled = false;
let recognitionWorker = null;
let recognitionInterval = null;
let recognitionBusy = false;
let recognitionSession = 0;
let tesseractScriptPromise = null;

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function roomCoordinates(room) {
  if (!room) {
    return null;
  }
  if (room.latitude === null || room.latitude === undefined || room.latitude === "" ||
      room.longitude === null || room.longitude === undefined || room.longitude === "") {
    return defaultRoomCoordinates(room);
  }
  const lat = Number(room.latitude);
  const lng = Number(room.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    ? { lat, lng }
    : null;
}

function roomTitle(room) {
  const number = String(room.roomNumber || "").trim();
  if (!number) return room.name || "Campus space";
  return /^room\b/i.test(number) ? number : `Room ${number}`;
}

function distanceInMeters(from, to) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latDelta = radians(to.lat - from.lat);
  const lngDelta = radians(to.lng - from.lng);
  const value = Math.sin(latDelta / 2) ** 2 +
    Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(lngDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function directionsUrl(destination, origin = null) {
  if (destination) {
    const url = new URL("https://www.google.com/maps/dir/");
    url.searchParams.set("api", "1");
    url.searchParams.set("destination", `${destination.lat},${destination.lng}`);
    if (origin) url.searchParams.set("origin", `${origin.lat},${origin.lng}`);
    return url.href;
  }
  return "";
}

function openSection(sectionId) {
  document.querySelectorAll(".section-tab").forEach((button) => {
    const active = button.dataset.target === sectionId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll(".dashboard-section").forEach((section) => {
    section.classList.toggle("active", section.id === sectionId);
  });
  if (sectionId !== "map") stopCameraView("Camera stopped because you left the map.");
}

document.querySelectorAll(".section-tab").forEach((button) => {
  button.addEventListener("click", () => openSection(button.dataset.target));
});

document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("[data-map-directions]") : null;
  if (!link) return;
  const room = campusRooms.find((item) => item.id === link.dataset.roomId);
  if (room) {
    recordMapUse(room).catch((error) => {
      console.error("Could not record map directions use:", error);
      $("feedbackMessage").textContent = "Directions opened, but this map use could not be recorded.";
    });
  }
  $("feedbackPrompt").hidden = false;
  openSection("evaluation");
  $("rating").focus();
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = "index.html";
    return;
  }
  currentUser = user;
  try {
    const profile = await getDoc(doc(db, "users", user.uid));
    currentRole = profile.exists() ? profile.data().role : "student";
    if (!["student", "visitor"].includes(currentRole)) {
      throw new Error("Student profile not found or invalid.");
    }
    currentStudentNumber = String(profile.data()?.studentNumber || "") ||
      localStorage.getItem(`pendingStudentNumber:${user.uid}`) || "";
    if (!profile.exists()) {
      showStudentSetup("This account needs its student number linked before arrival tracking is available.");
    } else if (currentRole === "student" && !currentStudentNumber) {
      showStudentSetup("Add your student number to enable arrival tracking.");
    } else if (currentRole === "visitor") {
      $("accountNoticeText").textContent = "Visitor access is read-only. Destination arrival tracking is available to student accounts.";
      $("accountNotice").hidden = false;
    }
    $("userEmail").textContent = `${currentStudentNumber ? `${currentStudentNumber} · ` : ""}${user.email || ""}`;
    const accountNotice = sessionStorage.getItem("studentNumberLinkNotice");
    if (accountNotice && currentRole === "student") {
      showStudentSetup(accountNotice);
      $("accountNotice").hidden = false;
      sessionStorage.removeItem("studentNumberLinkNotice");
    }
    await loadCampusData();
  } catch (error) {
    console.error("Could not load student profile:", error);
    $("locationMessage").textContent = "Could not verify your student account. Please sign in again or contact the administrator.";
    await signOut(auth);
    location.href = "index.html";
  }
});

function showStudentSetup(message) {
  $("accountNoticeText").textContent = message;
  $("accountStudentNumber").value =
    localStorage.getItem(`pendingStudentNumber:${currentUser.uid}`) || "";
  $("accountSetupForm").hidden = false;
  $("accountNotice").hidden = false;
}

$("accountSetupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const number = $("accountStudentNumber").value.trim();
  const status = $("accountSetupMessage");
  if (!/^\d{8}$/.test(number)) {
    status.textContent = "Enter your 8-digit student number.";
    return;
  }
  const button = $("accountSetupForm").querySelector("button");
  button.disabled = true;
  status.textContent = "Linking your student number…";
  try {
    await linkStudentNumber(db, functions, currentUser, number);
    currentStudentNumber = number;
    $("userEmail").textContent = `${number} · ${currentUser.email || ""}`;
    localStorage.removeItem(`pendingStudentNumber:${currentUser.uid}`);
    sessionStorage.removeItem("studentNumberLinkNotice");
    $("accountNotice").hidden = true;
  } catch (error) {
    console.error("Could not link student number:", error);
    status.textContent = error.code === "functions/already-exists"
      ? "That number is linked to another account. Contact the administrator to resolve it."
      : error.code === "permission-denied"
        ? "The account setup rules are not published yet. Please ask the administrator to update Firebase rules."
        : "Could not link that number. Check it and try again, or contact the administrator.";
  } finally {
    button.disabled = false;
  }
});

$("logout").addEventListener("click", async () => {
  try {
    await signOut(auth);
    location.href = "index.html";
  } catch (error) {
    console.error("Sign out failed:", error);
    window.alert(`Could not sign out: ${error.message}`);
  }
});

$("cameraToggle").addEventListener("click", () => {
  if (cameraStream) stopCameraView();
  else startCameraView();
});
$("confirmArrival").addEventListener("click", confirmCameraArrival);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && cameraStream) stopCameraView("Camera stopped while the page is in the background.");
});
window.addEventListener("pagehide", () => stopCameraView());

async function loadCampusData() {
  const results = await Promise.allSettled([
    getDocs(collection(db, "faculties")),
    getDocs(collection(db, "rooms")),
    getDocs(collection(db, "qrCodes"))
  ]);

  const [facultiesResult, roomsResult, qrResult] = results;
  if (facultiesResult.status === "fulfilled") {
    renderFaculties(facultiesResult.value);
  } else {
    renderLoadError("facultyList", "Could not load faculties", facultiesResult.reason);
  }
  if (roomsResult.status === "fulfilled") {
    campusRooms = roomsResult.value.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderRooms();
    renderCampusMap();
  } else {
    renderLoadError("roomList", "Could not load rooms", roomsResult.reason);
    renderLoadError("mapList", "Could not load mapped rooms", roomsResult.reason);
    $("mapDestination").innerHTML = '<option value="">Campus locations could not be loaded</option>';
    $("mapPlaceDetails").innerHTML = '<p class="error-state" role="status">Campus locations could not be loaded. Please try again later.</p>';
  }
  if (qrResult.status === "fulfilled") {
    renderQrGuides(qrResult.value);
  } else {
    renderLoadError("qrCodeList", "Could not load QR guides", qrResult.reason);
  }
}

function selectedMapRoom() {
  return campusRooms.find((room) => room.id === selectedMapRoomId) || null;
}

function updateMapPlaceDetails() {
  const details = $("mapPlaceDetails");
  const room = selectedMapRoom();
  if (!room) {
    details.innerHTML = '<span class="card-kicker">CAMPUS DIRECTORY</span><h3>Choose a destination</h3><p>Select a room above to view its details and available directions.</p>';
    return;
  }

  const coordinates = roomCoordinates(room);
  const direction = coordinates ? directionsUrl(coordinates, currentPosition) : safeHttpUrl(room.mapLink);
  details.innerHTML = `<span class="card-kicker">${esc(room.building || "CAMPUS")}</span>
    <h3>${esc(roomTitle(room))}</h3>
    <p>${esc(room.description || room.roomType || "Campus room")}${room.floor ? ` · ${esc(room.floor)}` : ""}</p>
    ${direction ? `<a class="text-link" data-map-directions data-room-id="${esc(room.id)}" href="${esc(direction)}" target="_blank" rel="noopener noreferrer">Get directions <span aria-hidden="true">↗</span></a>` : '<p class="muted-note">Directions are not available for this location yet.</p>'}`;
}

async function recordMapUse(room) {
  if (currentRole !== "student" || !currentStudentNumber) return;
  await addDoc(collection(db, "transactions"), {
    userId: currentUser.uid,
    studentNumber: currentStudentNumber,
    roomId: room.id,
    roomNumber: String(room.roomNumber || ""),
    building: String(room.building || room.name || "Campus"),
    method: "directions",
    createdAt: serverTimestamp()
  });
}

function renderCampusMap() {
  const select = $("mapDestination");
  const destinations = campusRooms.slice().sort((a, b) => roomTitle(a).localeCompare(roomTitle(b)));
  select.innerHTML = `<option value="">Choose a room or location</option>${destinations
    .map((room) => `<option value="${esc(room.id)}">${esc(roomTitle(room))} — ${esc(room.building || room.name || "Campus")}</option>`)
    .join("")}`;
  if (!destinations.some((room) => room.id === selectedMapRoomId)) selectedMapRoomId = "";
  select.value = selectedMapRoomId;
  select.onchange = () => {
    selectedMapRoomId = select.value;
    pendingArrivalRoomId = "";
    $("confirmArrival").hidden = true;
    updateMapPlaceDetails();
    updateCameraGuidance();
  };
  updateMapPlaceDetails();
  updateCameraGuidance();
}

function updateCampusMapLocation() {
  updateMapPlaceDetails();
  updateCameraGuidance();
}
function handleDeviceOrientation(event) {
  if (Number.isFinite(event.webkitCompassHeading)) {
    cameraHeading = event.webkitCompassHeading;
  } else if (Number.isFinite(event.alpha)) {
    const screenAngle = Number(window.screen.orientation?.angle ?? window.orientation ?? 0);
    cameraHeading = (360 - event.alpha + screenAngle + 360) % 360;
  }
  updateCameraGuidance();
}

async function requestCameraOrientationPermission() {
  const OrientationEvent = window.DeviceOrientationEvent;
  if (!OrientationEvent) return false;
  if (typeof OrientationEvent.requestPermission === "function") {
    try {
      return await OrientationEvent.requestPermission() === "granted";
    } catch (error) {
      console.error("Could not request compass permission:", error);
      return false;
    }
  }
  return true;
}

function updateCameraGuidance() {
  if (!cameraStream) return;
  const marker = $("cameraMarker");
  const arrow = marker.querySelector(".camera-marker-arrow");
  const room = selectedMapRoom();
  const destination = roomCoordinates(room);
  const status = $("cameraStatus");
  if (!room) {
    marker.hidden = true;
    status.textContent = "Choose a room from Find a room to show its direction in the camera view.";
    return;
  }
  if (!destination) {
    marker.hidden = true;
    status.textContent = "This destination has no coordinates yet. Camera preview is active; ask an administrator to add the location.";
    return;
  }
  if (!currentPosition) {
    marker.hidden = true;
    status.textContent = "Choose Use my location to compare your position with the selected destination. Camera video stays on this device.";
    return;
  }
  if (cameraHeading === null || !cameraOrientationEnabled) {
    marker.hidden = true;
    status.textContent = "Compass heading is unavailable. You can still use the map and Get directions.";
    return;
  }

  const radians = Math.PI / 180;
  const latitude1 = currentPosition.lat * radians;
  const latitude2 = destination.lat * radians;
  const longitudeDelta = (destination.lng - currentPosition.lng) * radians;
  const bearing = (Math.atan2(
    Math.sin(longitudeDelta) * Math.cos(latitude2),
    Math.cos(latitude1) * Math.sin(latitude2) -
      Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(longitudeDelta)
  ) * 180 / Math.PI + 360) % 360;
  const difference = ((bearing - cameraHeading + 540) % 360) - 180;
  const markerPosition = Math.max(8, Math.min(92, 50 + difference * 0.9));
  const distance = distanceInMeters(currentPosition, destination);
  const distanceLabel = distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km`;
  marker.hidden = false;
  marker.style.left = `${markerPosition}%`;
  arrow.style.transform = `rotate(${Math.max(-45, Math.min(45, difference))}deg)`;
  $("cameraMarkerLabel").textContent = `${roomTitle(room)} · ${distanceLabel}`;
  if (Math.abs(difference) > 18) {
    status.textContent = `Turn ${difference > 0 ? "right" : "left"} toward ${roomTitle(room)} · about ${distanceLabel} away.`;
  } else {
    status.textContent = `${roomTitle(room)} is roughly ahead · about ${distanceLabel} away.`;
  }
}

function stopCameraView(message = "") {
  const stream = cameraStream;
  cameraStream = null;
  cameraHeading = null;
  cameraOrientationEnabled = false;
  window.removeEventListener("deviceorientation", handleDeviceOrientation, true);
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stopSignRecognition(message || "Camera sign check stopped.");
  $("cameraVideo").srcObject = null;
  $("cameraView").hidden = true;
  $("cameraToggle").textContent = "Use camera";
  $("cameraMarker").hidden = true;
  $("confirmArrival").hidden = true;
  pendingArrivalRoomId = "";
  if (message) $("cameraStatus").textContent = message;
}

async function confirmCameraArrival() {
  const room = selectedMapRoom();
  const button = $("confirmArrival");
  if (currentRole !== "student" || !currentStudentNumber ||
      !currentUser || !room || pendingArrivalRoomId !== room.id || arrivalRecordedRoomIds.has(room.id)) {
    return;
  }

  button.disabled = true;
  $("cameraStatus").textContent = "Recording your arrival…";
  try {
    await addDoc(collection(db, "transactions"), {
      userId: currentUser.uid,
      studentNumber: currentStudentNumber,
      roomId: room.id,
      roomNumber: String(room.roomNumber),
      building: String(room.building || room.name || "Campus"),
      method: "camera",
      createdAt: serverTimestamp()
    });
    arrivalRecordedRoomIds.add(room.id);
    pendingArrivalRoomId = "";
    $("recognitionStatus").textContent = `Arrival recorded for ${roomTitle(room)}. Thank you for checking in.`;
    $("cameraStatus").textContent = "Your destination visit has been recorded.";
    $("feedbackPrompt").hidden = false;
    openSection("evaluation");
    $("rating").focus();
  } catch (error) {
    console.error("Could not record destination arrival:", error);
    $("cameraStatus").textContent = "Could not record your arrival. Check your connection and try again.";
  } finally {
    button.disabled = false;
    button.hidden = true;
  }
}

function loadTesseractScript() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractScriptPromise) return tesseractScriptPromise;
  tesseractScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.async = true;
    script.onload = () => {
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error("The OCR library did not initialize."));
    };
    script.onerror = () => reject(new Error("The OCR library could not be downloaded."));
    document.head.appendChild(script);
  }).catch((error) => {
    tesseractScriptPromise = null;
    throw error;
  });
  return tesseractScriptPromise;
}

function recognizesRoomNumber(text, room) {
  const expected = String(room?.roomNumber || "")
    .replace(/^(room|rm|no\.?)\s*/i, "")
    .replace(/[^a-z0-9]/gi, "");
  if (!expected) return false;
  const pattern = [...expected].join("[^a-z0-9]*");
  return new RegExp(`(^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`, "i").test(text);
}

async function recognizeCameraSign(stream, session) {
  if (!recognitionWorker || recognitionBusy || cameraStream !== stream) return;
  const video = $("cameraVideo");
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
  recognitionBusy = true;
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1280 / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const result = await recognitionWorker.recognize(canvas);
    if (session !== recognitionSession || cameraStream !== stream) return;

    const text = result.data.text || "";
    const room = selectedMapRoom();
    if (!room) {
      $("confirmArrival").hidden = true;
      $("recognitionStatus").textContent = "Choose a destination first, then point the camera at its room number.";
      return;
    }
    if (arrivalRecordedRoomIds.has(room.id)) {
      $("confirmArrival").hidden = true;
      $("recognitionStatus").textContent = `Arrival for ${roomTitle(room)} is already recorded.`;
      return;
    }
    if (!room.roomNumber) {
      $("confirmArrival").hidden = true;
      $("recognitionStatus").textContent = "This destination has no room number to check. Ask an administrator to add one.";
      return;
    }
    if (recognizesRoomNumber(text, room)) {
      pendingArrivalRoomId = room.id;
      $("confirmArrival").textContent = `Confirm arrival at ${roomTitle(room)}`;
      $("confirmArrival").hidden = currentRole !== "student" || !currentStudentNumber;
      $("recognitionStatus").textContent = currentRole === "student" && currentStudentNumber
        ? `Possible match for ${roomTitle(room)}. Verify you are there, then confirm arrival.`
        : "Room number recognized. Arrival tracking is available to student accounts with a linked student number.";
    } else {
      pendingArrivalRoomId = "";
      $("confirmArrival").hidden = true;
      $("recognitionStatus").textContent = `Looking for room number ${room.roomNumber}. Aim at the destination sign and move closer.`;
    }
  } catch (error) {
    if (session === recognitionSession && cameraStream === stream) {
      console.error("Could not recognize the room sign:", error);
      $("recognitionStatus").textContent = "Could not read the camera frame. Check permission and try aiming at the sign again.";
    }
  } finally {
    if (session === recognitionSession) recognitionBusy = false;
  }
}

async function startSignRecognition(stream) {
  const session = ++recognitionSession;
  const status = $("recognitionStatus");
  status.textContent = "Loading on-device text recognition… Frames are not uploaded or saved.";
  try {
    const tesseract = await loadTesseractScript();
    if (cameraStream !== stream || session !== recognitionSession) return;
    const worker = await tesseract.createWorker("eng");
    if (cameraStream !== stream || session !== recognitionSession) {
      await worker.terminate();
      return;
    }
    recognitionWorker = worker;
    status.textContent = "Point the camera at the selected destination’s room number.";
    recognitionInterval = window.setInterval(() => recognizeCameraSign(stream, session), 1800);
    await recognizeCameraSign(stream, session);
  } catch (error) {
    if (session === recognitionSession && cameraStream === stream) {
      console.error("Could not start on-device sign recognition:", error);
      status.textContent = "Sign recognition could not load. Check your internet connection; the camera preview is still available.";
    }
  }
}

function stopSignRecognition(message = "") {
  recognitionSession += 1;
  if (recognitionInterval !== null) {
    window.clearInterval(recognitionInterval);
    recognitionInterval = null;
  }
  const worker = recognitionWorker;
  recognitionWorker = null;
  recognitionBusy = false;
  if (worker) {
    worker.terminate().catch((error) => console.error("Could not stop sign recognition cleanly:", error));
  }
  if (message && $("recognitionStatus")) $("recognitionStatus").textContent = message;
}

async function startCameraView() {
  const status = $("cameraStatus");
  const button = $("cameraToggle");
  if (!window.isSecureContext) {
    $("cameraView").hidden = false;
    status.textContent = "Camera access requires HTTPS or localhost. The map works without camera access.";
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    $("cameraView").hidden = false;
    status.textContent = "Camera access is not supported in this browser. You can still use the map.";
    return;
  }

  button.disabled = true;
  button.textContent = "Requesting permission…";
  $("cameraView").hidden = false;
  status.textContent = "Waiting for camera and compass permission. Camera video is not recorded or uploaded.";
  $("recognitionStatus").textContent = "Waiting for camera permission…";
  cameraHeading = null;
  cameraOrientationEnabled = await requestCameraOrientationPermission();
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } }
    });
    const stream = cameraStream;
    $("cameraVideo").srcObject = stream;
    $("cameraView").hidden = false;
    await $("cameraVideo").play();
    $("cameraToggle").textContent = "Stop camera";
    if (cameraOrientationEnabled) {
      window.addEventListener("deviceorientation", handleDeviceOrientation, true);
    }
    stream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (cameraStream === stream) stopCameraView("Camera access ended.");
      }, { once: true });
    });
    updateCameraGuidance();
    startSignRecognition(stream);
  } catch (error) {
    console.error("Could not start camera view:", error);
    stopCameraView();
    $("cameraView").hidden = false;
    $("recognitionStatus").textContent = "Room sign checking is unavailable until camera permission is granted.";
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      status.textContent = "Camera permission was denied. Allow camera access in your browser settings, or continue using the map.";
    } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      status.textContent = "No camera was found on this device. You can still use the map.";
    } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      status.textContent = "The camera is unavailable or already in use by another app. You can still use the map.";
    } else {
      status.textContent = `Could not start the camera: ${error.message || "unknown browser error"}. You can still use the map.`;
    }
  } finally {
    button.disabled = false;
  }
}

function renderLoadError(elementId, message, error) {
  console.error(`${message}:`, error);
  $(elementId).innerHTML = `<p class="error-state">${esc(message)}. Please try again later.</p>`;
}

function renderFaculties(snapshot) {
  const list = $("facultyList");
  if (snapshot.empty) {
    list.innerHTML = '<p class="empty-state">No faculty information has been added yet.</p>';
    return;
  }
  list.innerHTML = snapshot.docs.map((item) => {
    const data = item.data();
    const image = safeHttpUrl(data.image) || (String(data.image || "").startsWith("data:image/") ? data.image : "");
    return `<article class="card">
      ${image ? `<img class="card-image" src="${esc(image)}" alt="">` : '<div class="card-art" aria-hidden="true">⌂</div>'}
      <div class="card-content"><span class="card-kicker">FACULTY</span><h3>${esc(data.name || "Faculty")}</h3>
      <p>${esc(data.description || "Campus faculty information.")}</p>
      <dl class="detail-list">${data.location ? `<div><dt>Location</dt><dd>${esc(data.location)}</dd></div>` : ""}
      ${data.contact ? `<div><dt>Contact</dt><dd>${esc(data.contact)}</dd></div>` : ""}
      ${data.hours ? `<div><dt>Office hours</dt><dd>${esc(data.hours)}</dd></div>` : ""}</dl></div>
    </article>`;
  }).join("");
}

function renderRooms() {
  const sortedRooms = [...campusRooms].sort((a, b) => {
    if (!currentPosition) return String(a.roomNumber || "").localeCompare(String(b.roomNumber || ""));
    const aCoords = roomCoordinates(a);
    const bCoords = roomCoordinates(b);
    if (!aCoords) return 1;
    if (!bCoords) return -1;
    return distanceInMeters(currentPosition, aCoords) - distanceInMeters(currentPosition, bCoords);
  });
  const roomMarkup = (room, showDistance) => {
    const coords = roomCoordinates(room);
    const image = safeHttpUrl(room.mapUrl) || (String(room.mapUrl || "").startsWith("data:image/") ? room.mapUrl : "");
    const distance = currentPosition && coords ? distanceInMeters(currentPosition, coords) : null;
    const direction = coords ? directionsUrl(coords, currentPosition) : safeHttpUrl(room.mapLink);
    return `<article class="card">
      ${image ? `<img class="card-image" src="${esc(image)}" alt="Floor plan for room ${esc(room.roomNumber || "")}">` : '<div class="card-art campus-art" role="img" aria-label="La Concepcion College campus"></div>'}
      <div class="card-content"><span class="card-kicker">${esc(room.building || "CAMPUS")} ${room.floor ? `· ${esc(room.floor)}` : ""}</span>
      <h3>${esc(roomTitle(room))}</h3>
      <p>${esc(room.description || room.roomType || "Campus room")}</p>
      ${showDistance && distance !== null ? `<p class="distance-label">${distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km`} from you</p>` : ""}
      ${direction ? `<a class="text-link" data-map-directions data-room-id="${esc(room.id)}" href="${esc(direction)}" target="_blank" rel="noopener noreferrer">${currentPosition && coords ? "Get directions" : "View location"} <span aria-hidden="true">↗</span></a>` : (coords ? "" : '<p class="muted-note">Location coordinates not added yet.</p>')}
      </div>
    </article>`;
  };

  $("roomList").innerHTML = sortedRooms.length
    ? sortedRooms.map((room) => roomMarkup(room, true)).join("")
    : '<p class="empty-state">No rooms have been added yet.</p>';
  const mappedRooms = sortedRooms.filter((room) => roomCoordinates(room) || safeHttpUrl(room.mapLink));
  $("mapList").innerHTML = mappedRooms.length
    ? mappedRooms.map((room) => roomMarkup(room, true)).join("")
    : '<p class="empty-state">No mapped rooms yet. Campus administrators can add room coordinates.</p>';
}

function renderQrGuides(snapshot) {
  const list = $("qrCodeList");
  if (snapshot.empty) {
    list.innerHTML = '<p class="empty-state">No QR guides have been added yet.</p>';
    return;
  }
  list.innerHTML = snapshot.docs.map((item) => {
    const data = item.data();
    const target = safeHttpUrl(data.targetUrl || data.pdfLink);
    const oldImage = String(data.image || "").startsWith("data:image/") ? data.image : safeHttpUrl(data.image);
    const qrMarkup = target && window.QRCode
      ? `<div class="qr-image" id="qr-${esc(item.id)}" data-qr-target="${esc(target)}" aria-label="QR code for ${esc(data.name || "campus guide")}"></div>`
      : oldImage ? `<img class="qr-image" src="${esc(oldImage)}" alt="QR code for ${esc(data.name || "campus guide")}">` : '<div class="qr-unavailable">QR preview unavailable</div>';
    return `<article class="qr-card"><div class="qr-card-image">${qrMarkup}</div><div class="card-content">
      <span class="card-kicker">CAMPUS GUIDE</span><h3>${esc(data.name || "Campus guide")}</h3>
      ${target ? `<a class="text-link" href="${esc(target)}" target="_blank" rel="noopener noreferrer">Open destination <span aria-hidden="true">↗</span></a>` : '<p class="muted-note">This guide does not have a valid web destination.</p>'}
      </div></article>`;
  }).join("");
  if (window.QRCode) {
    list.querySelectorAll("[data-qr-target]").forEach((container) => {
      new window.QRCode(container, {
        text: container.dataset.qrTarget,
        width: 156,
        height: 156,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: window.QRCode.CorrectLevel.M
      });
    });
  }
}

$("locateMe").addEventListener("click", () => {
  const message = $("locationMessage");
  if (!navigator.geolocation) {
    message.textContent = "Location is not available in this browser. Try a recent browser on HTTPS or localhost.";
    return;
  }
  const button = $("locateMe");
  button.disabled = true;
  message.textContent = "Requesting your location…";
  navigator.geolocation.getCurrentPosition((position) => {
    currentPosition = { lat: position.coords.latitude, lng: position.coords.longitude };
    const accuracy = Math.round(position.coords.accuracy);
    message.textContent = `Location ready (about ${accuracy} m accuracy). Your coordinates are kept on this device.`;
    $("locationSummary").hidden = false;
    $("locationSummary").innerHTML = `<span class="location-dot"></span><span>Current position</span><strong>${currentPosition.lat.toFixed(5)}, ${currentPosition.lng.toFixed(5)}</strong><span class="muted-note">Not saved to your account</span>`;
    renderRooms();
    updateCampusMapLocation();
    button.disabled = false;
  }, (error) => {
    const messages = {
      1: "Location permission was denied. Allow access in your browser settings to see nearby rooms.",
      2: "Your location could not be determined. Check your device location settings and try again.",
      3: "The location request timed out. Please try again."
    };
    message.textContent = messages[error.code] || "Could not get your location. Please try again.";
    button.disabled = false;
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
});

$("feedbackForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const feedbackMessage = $("feedbackMessage");
  const submitButton = $("submitFeedback");
  if (!currentUser) {
    feedbackMessage.textContent = "Please wait for your account to load.";
    return;
  }
  const rating = Number($("rating").value);
  const comment = $("comment").value.trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    feedbackMessage.textContent = "Please choose a rating from 1 to 5.";
    return;
  }
  submitButton.disabled = true;
  feedbackMessage.textContent = "Sending feedback…";
  try {
    await addDoc(collection(db, "feedback"), {
      rating,
      comment,
      userId: currentUser.uid,
      createdAt: serverTimestamp()
    });
    $("feedbackForm").reset();
    feedbackMessage.textContent = "Thank you — your feedback has been sent.";
  } catch (error) {
    console.error("Feedback submission failed:", error);
    feedbackMessage.textContent = "Could not send feedback. Please try again.";
  } finally {
    submitButton.disabled = false;
  }
});
