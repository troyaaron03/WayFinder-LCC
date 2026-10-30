import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

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
const $ = (id) => document.getElementById(id);
let currentUser = null;
let campusRooms = [];
let currentPosition = null;
let campusMap = null;
let campusMapBuildings = [];
let selectedMapBuilding = null;
let selectedMapRoomId = "";
let mapResizeObserver = null;
let cameraStream = null;
let cameraHeading = null;
let cameraOrientationEnabled = false;

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
  if (!room || room.latitude === null || room.latitude === undefined || room.latitude === "" ||
      room.longitude === null || room.longitude === undefined || room.longitude === "") {
    return null;
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
  if (sectionId === "map") resizeCampusMap();
  else stopCameraView("Camera stopped because you left the map.");
}

document.querySelectorAll(".section-tab").forEach((button) => {
  button.addEventListener("click", () => openSection(button.dataset.target));
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = "index.html";
    return;
  }
  currentUser = user;
  $("userEmail").textContent = user.email || "";
  await loadCampusData();
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
    await renderCampusMap();
  } else {
    renderLoadError("roomList", "Could not load rooms", roomsResult.reason);
    renderLoadError("mapList", "Could not load campus map", roomsResult.reason);
    $("campusMap").innerHTML = '<p class="campus-map-message error-state" role="status">Campus locations could not be loaded. Please try again later.</p>';
  }
  if (qrResult.status === "fulfilled") {
    renderQrGuides(qrResult.value);
  } else {
    renderLoadError("qrCodeList", "Could not load QR guides", qrResult.reason);
  }
}

function buildingName(room) {
  return String(room.building || room.name || roomTitle(room)).trim();
}

function buildCampusPlaces(rooms) {
  const grouped = new Map();
  rooms.forEach((room) => {
    const name = buildingName(room);
    const key = name.toLocaleLowerCase();
    if (!grouped.has(key)) grouped.set(key, { name, rooms: [], coordinates: [] });
    const building = grouped.get(key);
    building.rooms.push(room);
    const coordinates = roomCoordinates(room);
    if (coordinates) building.coordinates.push(coordinates);
  });

  return [...grouped.values()].map((building) => ({
    ...building,
    coordinates: building.coordinates.length
      ? {
          lat: building.coordinates.reduce((sum, point) => sum + point.lat, 0) / building.coordinates.length,
          lng: building.coordinates.reduce((sum, point) => sum + point.lng, 0) / building.coordinates.length
        }
      : null
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function addCampusLabel(THREE, building, height) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  context.fillStyle = "rgba(16, 47, 86, 0.88)";
  context.fillRect(6, 6, 500, 116);
  context.font = "700 36px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#ffffff";
  const label = building.name.length > 23 ? `${building.name.slice(0, 21)}…` : building.name;
  context.fillText(label, 256, 65, 460);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const labelSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  labelSprite.scale.set(12, 3, 1);
  labelSprite.position.set(0, height + 3, 0);
  building.group.add(labelSprite);
}

function projectCampusCoordinates(coordinates) {
  if (!campusMap?.coordinateOrigin || !coordinates) return null;
  const radians = Math.PI / 180;
  return {
    x: (coordinates.lng - campusMap.coordinateOrigin.lng) * 111320 *
      Math.cos(campusMap.coordinateOrigin.lat * radians) * campusMap.coordinateScale,
    z: -(coordinates.lat - campusMap.coordinateOrigin.lat) * 110540 * campusMap.coordinateScale
  };
}

function addCampusBuilding(THREE, building, index, position) {
  const roomCount = building.rooms.length;
  const floors = new Set(building.rooms.map((room) => String(room.floor || "").trim()).filter(Boolean)).size;
  const height = Math.min(19, 6 + Math.max(floors, Math.ceil(roomCount / 5)) * 2.2);
  const width = 8.5 + Math.min(3, Math.floor(roomCount / 8));
  const depth = 7 + Math.min(2, Math.floor(roomCount / 10));
  const group = new THREE.Group();
  group.position.set(position.x, 0, position.z);

  const palette = [0x9eb7c5, 0xb9a98e, 0xa2b9a2, 0xb7a3a0, 0xa5adbf];
  const material = new THREE.MeshStandardMaterial({
    color: palette[index % palette.length],
    roughness: 0.82,
    emissive: 0x000000
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  body.position.y = height / 2 + 0.35;
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.building = building;
  group.add(body);

  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.8, 0.7, depth + 0.8),
    new THREE.MeshStandardMaterial({ color: 0x536e78, roughness: 0.8 })
  );
  roof.position.y = height + 0.7;
  roof.castShadow = true;
  group.add(roof);

  const windowMaterial = new THREE.MeshStandardMaterial({ color: 0xe7f1e8, roughness: 0.38 });
  const rows = Math.max(1, Math.min(5, Math.floor(height / 3)));
  for (let row = 0; row < rows; row += 1) {
    for (let column = -1; column <= 1; column += 1) {
      const windowMesh = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.9, 0.12), windowMaterial);
      windowMesh.position.set(column * 2.2, 2.1 + row * 2.5, depth / 2 + 0.08);
      group.add(windowMesh);
    }
  }

  const foundation = new THREE.Mesh(
    new THREE.BoxGeometry(width + 2.2, 0.7, depth + 2.2),
    new THREE.MeshStandardMaterial({ color: 0xd4dfc9, roughness: 1 })
  );
  foundation.position.y = 0.25;
  foundation.receiveShadow = true;
  group.add(foundation);
  building.group = group;
  building.mesh = body;
  building.position = position;
  building.floorCount = floors;
  addCampusLabel(THREE, building, height);
  campusMap.scene.add(group);
}

function setCampusMapCamera() {
  if (!campusMap) return;
  const { camera, target, theta, phi, distance } = campusMap;
  camera.position.set(
    target.x + distance * Math.sin(phi) * Math.sin(theta),
    target.y + distance * Math.cos(phi),
    target.z + distance * Math.sin(phi) * Math.cos(theta)
  );
  camera.lookAt(target);
}

function updateMapPlaceDetails() {
  const details = $("mapPlaceDetails");
  const building = campusMapBuildings.find((item) => item.name === selectedMapBuilding);
  if (!building) {
    details.innerHTML = '<span class="card-kicker">CAMPUS DIRECTORY</span><h3>Select a building</h3><p>Choose a room from the list or select a building in the 3D view to see its details.</p>';
    return;
  }

  const room = building.rooms.find((item) => item.id === selectedMapRoomId) || building.rooms[0];
  const coordinates = roomCoordinates(room) || building.coordinates;
  const direction = coordinates ? directionsUrl(coordinates, currentPosition) : safeHttpUrl(room.mapLink);
  const roomNames = building.rooms.slice(0, 8).map((item) =>
    `<li>${esc(roomTitle(item))}${item.floor ? ` · ${esc(item.floor)}` : ""}</li>`
  ).join("");
  const moreRooms = building.rooms.length > 8
    ? `<li>And ${building.rooms.length - 8} more location${building.rooms.length - 8 === 1 ? "" : "s"}</li>`
    : "";
  details.innerHTML = `<span class="card-kicker">CAMPUS BUILDING</span>
    <h3>${esc(building.name)}</h3>
    <p>${building.rooms.length} listed location${building.rooms.length === 1 ? "" : "s"}${building.floorCount ? ` · ${building.floorCount} floor${building.floorCount === 1 ? "" : "s"} recorded` : ""}</p>
    ${room.description ? `<p>${esc(room.description)}</p>` : ""}
    ${direction ? `<a class="text-link" href="${esc(direction)}" target="_blank" rel="noopener noreferrer">Get directions <span aria-hidden="true">↗</span></a>` : '<p class="muted-note">Directions are not available for this location yet.</p>'}
    <ul class="map-room-list">${roomNames}${moreRooms}</ul>`;
}

function selectCampusBuilding(name, roomId = "") {
  selectedMapBuilding = name;
  const building = campusMapBuildings.find((item) => item.name === name);
  selectedMapRoomId = roomId || building?.rooms[0]?.id || "";
  campusMapBuildings.forEach((item) => {
    if (item.mesh) item.mesh.material.emissive.setHex(item.name === name ? 0x264f37 : 0x000000);
  });
  const room = building?.rooms.find((item) => item.id === selectedMapRoomId) || building?.rooms[0];
  $("mapDestination").value = room?.id || "";
  updateMapPlaceDetails();
  updateCampusMapRoute();
  updateCameraGuidance();
}

function updateCampusMapRoute() {
  if (!campusMap) return;
  if (campusMap.routeLine) {
    campusMap.scene.remove(campusMap.routeLine);
    campusMap.routeLine.geometry.dispose();
    campusMap.routeLine.material.dispose();
    campusMap.routeLine = null;
  }
  if (campusMap.locationMarker) {
    campusMap.scene.remove(campusMap.locationMarker);
    campusMap.locationMarker.geometry.dispose();
    campusMap.locationMarker.material.dispose();
    campusMap.locationMarker = null;
  }

  if (currentPosition) {
    const point = projectCampusCoordinates(currentPosition);
    if (point && Math.hypot(point.x, point.z) <= campusMap.radius * 2.5) {
      const THREE = campusMap.THREE;
      campusMap.locationMarker = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 16, 12),
        new THREE.MeshStandardMaterial({ color: 0x2878bf, emissive: 0x143d66 })
      );
      campusMap.locationMarker.position.set(point.x, 1.4, point.z);
      campusMap.scene.add(campusMap.locationMarker);

      const building = campusMapBuildings.find((item) => item.name === selectedMapBuilding);
      const selectedRoom = building?.rooms.find((room) => room.id === selectedMapRoomId) || building?.rooms[0];
      const destination = projectCampusCoordinates(roomCoordinates(selectedRoom) || building?.coordinates);
      if (destination) {
        const line = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(point.x, 1.4, point.z),
          new THREE.Vector3(destination.x, 1.4, destination.z)
        ]);
        campusMap.routeLine = new THREE.Line(line, new THREE.LineBasicMaterial({ color: 0x2878bf }));
        campusMap.scene.add(campusMap.routeLine);
      }
    }
  }
}

function resizeCampusMap() {
  if (!campusMap) return;
  const width = campusMap.container.clientWidth;
  const height = campusMap.container.clientHeight;
  if (!width || !height) return;
  campusMap.renderer.setSize(width, height, false);
  campusMap.camera.aspect = width / height;
  campusMap.camera.updateProjectionMatrix();
}

async function renderCampusMap() {
  const container = $("campusMap");
  const select = $("mapDestination");
  campusMapBuildings = buildCampusPlaces(campusRooms);
  const roomToBuilding = new Map();
  campusMapBuildings.forEach((building) => {
    building.rooms.forEach((room) => roomToBuilding.set(room.id, building));
  });
  select.innerHTML = `<option value="">Choose a room or location</option>${campusRooms
    .slice()
    .sort((a, b) => roomTitle(a).localeCompare(roomTitle(b)))
    .map((room) => {
      const building = roomToBuilding.get(room.id);
      return `<option value="${esc(room.id)}">${esc(roomTitle(room))} — ${esc(building.name)}</option>`;
    }).join("")}`;
  select.onchange = () => {
    const room = campusRooms.find((item) => item.id === select.value);
    if (room) selectCampusBuilding(roomToBuilding.get(room.id).name, room.id);
    else selectCampusBuilding("");
  };

  if (!campusMapBuildings.length) {
    container.innerHTML = '<p class="campus-map-message" role="status">No campus locations have been added yet. Ask an administrator to add rooms to build the map.</p>';
    return;
  }

  container.innerHTML = '<p class="campus-map-message" role="status">Preparing the interactive map…</p>';
  try {
    const THREE = await import("three");
    const coordinates = campusMapBuildings.map((building) => building.coordinates).filter(Boolean);
    const coordinateOrigin = coordinates.length
      ? {
          lat: coordinates.reduce((sum, point) => sum + point.lat, 0) / coordinates.length,
          lng: coordinates.reduce((sum, point) => sum + point.lng, 0) / coordinates.length
        }
      : null;
    const radians = Math.PI / 180;
    const geographicPositions = campusMapBuildings
      .filter((building) => building.coordinates)
      .map((building) => ({
        building,
        x: (building.coordinates.lng - coordinateOrigin.lng) * 111320 *
          Math.cos(coordinateOrigin.lat * radians),
        z: -(building.coordinates.lat - coordinateOrigin.lat) * 110540
      }));
    const extent = geographicPositions.reduce((max, point) =>
      Math.max(max, Math.abs(point.x), Math.abs(point.z)), 0);
    const coordinateScale = extent > 0 ? 70 / extent : 1;
    const positioned = geographicPositions.map((point) => ({
      ...point,
      x: point.x * coordinateScale,
      z: point.z * coordinateScale
    }));
    const maxX = positioned.reduce((max, point) => Math.max(max, point.x), 0);
    const unlocated = campusMapBuildings.filter((building) => !building.coordinates);
    const fallbackColumns = Math.max(1, Math.ceil(Math.sqrt(unlocated.length)));
    unlocated.forEach((building, index) => {
      const row = Math.floor(index / fallbackColumns);
      const column = index % fallbackColumns;
      positioned.push({
        building,
        x: coordinates.length ? maxX + 18 + column * 17 : (column - (fallbackColumns - 1) / 2) * 17,
        z: (row - (Math.ceil(unlocated.length / fallbackColumns) - 1) / 2) * 17
      });
    });

    const mapMinX = positioned.reduce((min, point) => Math.min(min, point.x - 12), 0);
    const mapMaxX = positioned.reduce((max, point) => Math.max(max, point.x + 12), 0);
    const mapMinZ = positioned.reduce((min, point) => Math.min(min, point.z - 12), 0);
    const mapMaxZ = positioned.reduce((max, point) => Math.max(max, point.z + 12), 0);
    const mapWidth = Math.max(110, mapMaxX - mapMinX + 24);
    const mapDepth = Math.max(110, mapMaxZ - mapMinZ + 24);
    const target = new THREE.Vector3((mapMinX + mapMaxX) / 2, 0, (mapMinZ + mapMaxZ) / 2);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdcecf4);
    scene.fog = new THREE.Fog(0xdcecf4, 150, 360);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);
    campusMap = {
      THREE, container, scene, camera, renderer, target,
      coordinateOrigin, coordinateScale,
      theta: 0.72,
      phi: 0.95,
      distance: Math.max(68, Math.hypot(mapWidth, mapDepth) * 0.9),
      radius: Math.max(mapWidth, mapDepth) / 2,
      routeLine: null,
      locationMarker: null
    };

    scene.add(new THREE.HemisphereLight(0xffffff, 0x85977b, 2.1));
    const sunlight = new THREE.DirectionalLight(0xffffff, 2.2);
    sunlight.position.set(-45, 80, 35);
    sunlight.castShadow = true;
    scene.add(sunlight);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(mapWidth, mapDepth),
      new THREE.MeshStandardMaterial({ color: 0xb8cbae, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(target.x, -0.15, target.z);
    ground.receiveShadow = true;
    scene.add(ground);

    const gridSize = Math.max(mapWidth, mapDepth);
    const grid = new THREE.GridHelper(gridSize, Math.max(10, Math.ceil(gridSize / 8)), 0x94a98d, 0xa7b89e);
    grid.position.set(target.x, -0.1, target.z);
    scene.add(grid);

    const pathMaterial = new THREE.MeshStandardMaterial({ color: 0xe5e0d1, roughness: 1 });
    const path = new THREE.Mesh(new THREE.BoxGeometry(mapWidth * 0.76, 0.08, 3), pathMaterial);
    path.position.set(target.x, 0, target.z);
    scene.add(path);
    const crossPath = new THREE.Mesh(new THREE.BoxGeometry(3, 0.08, mapDepth * 0.76), pathMaterial);
    crossPath.position.set(target.x, 0, target.z);
    scene.add(crossPath);

    positioned.forEach((point, index) => addCampusBuilding(THREE, point.building, index, point));
    setCampusMapCamera();
    resizeCampusMap();
    if ("ResizeObserver" in window) {
      mapResizeObserver = new ResizeObserver(resizeCampusMap);
      mapResizeObserver.observe(container);
    }
    window.addEventListener("resize", resizeCampusMap);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerStart = null;
    let lastX = 0;
    let lastY = 0;
    renderer.domElement.addEventListener("pointerdown", (event) => {
      pointerStart = { x: event.clientX, y: event.clientY };
      lastX = event.clientX;
      lastY = event.clientY;
      renderer.domElement.setPointerCapture(event.pointerId);
    });
    renderer.domElement.addEventListener("pointermove", (event) => {
      if (!pointerStart || !(event.buttons & 1)) return;
      const deltaX = event.clientX - lastX;
      const deltaY = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      campusMap.theta -= deltaX * 0.008;
      campusMap.phi = Math.max(0.25, Math.min(1.42, campusMap.phi + deltaY * 0.006));
      setCampusMapCamera();
    });
    renderer.domElement.addEventListener("pointerup", (event) => {
      const moved = pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5;
      pointerStart = null;
      if (moved) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(campusMapBuildings.map((building) => building.mesh), false)[0];
      if (hit?.object.userData.building) selectCampusBuilding(hit.object.userData.building.name);
    });
    renderer.domElement.addEventListener("pointercancel", () => { pointerStart = null; });
    renderer.domElement.addEventListener("wheel", (event) => {
      event.preventDefault();
      campusMap.distance = Math.max(18, Math.min(campusMap.radius * 4, campusMap.distance * (event.deltaY > 0 ? 1.1 : 0.9)));
      setCampusMapCamera();
    }, { passive: false });
    container.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") campusMap.theta -= 0.1;
      else if (event.key === "ArrowRight") campusMap.theta += 0.1;
      else if (event.key === "ArrowUp") campusMap.phi = Math.max(0.25, campusMap.phi - 0.08);
      else if (event.key === "ArrowDown") campusMap.phi = Math.min(1.42, campusMap.phi + 0.08);
      else if (event.key === "+" || event.key === "=") campusMap.distance = Math.max(18, campusMap.distance * 0.9);
      else if (event.key === "-") campusMap.distance = Math.min(campusMap.radius * 4, campusMap.distance * 1.1);
      else return;
      event.preventDefault();
      setCampusMapCamera();
    });
    $("mapZoomIn").onclick = () => {
      if (!campusMap) return;
      campusMap.distance = Math.max(18, campusMap.distance * 0.82);
      setCampusMapCamera();
    };
    $("mapZoomOut").onclick = () => {
      if (!campusMap) return;
      campusMap.distance = Math.min(campusMap.radius * 4, campusMap.distance * 1.22);
      setCampusMapCamera();
    };
    $("mapReset").onclick = () => {
      if (!campusMap) return;
      campusMap.theta = 0.72;
      campusMap.phi = 0.95;
      campusMap.distance = Math.max(68, Math.hypot(mapWidth, mapDepth) * 0.9);
      setCampusMapCamera();
    };
    renderer.setAnimationLoop(() => renderer.render(scene, camera));
    if (selectedMapBuilding) {
      const stillExists = campusMapBuildings.find((building) => building.name === selectedMapBuilding);
      if (!stillExists) selectedMapBuilding = null;
    }
    if (selectedMapBuilding) selectCampusBuilding(selectedMapBuilding, selectedMapRoomId);
    else {
      if (currentPosition) updateCampusMapRoute();
      updateMapPlaceDetails();
    }
  } catch (error) {
    console.error("Could not initialize the 3D campus map:", error);
    campusMap = null;
    container.innerHTML = '<p class="campus-map-message error-state" role="status">The 3D map could not be loaded. Check your internet connection or use the mapped rooms list below.</p>';
  }
}

function updateCampusMapLocation() {
  updateCampusMapRoute();
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
  const building = campusMapBuildings.find((item) => item.name === selectedMapBuilding);
  const room = building?.rooms.find((item) => item.id === selectedMapRoomId) || building?.rooms[0];
  const destination = roomCoordinates(room) || building?.coordinates;
  const status = $("cameraStatus");
  if (!building || !room) {
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
  $("cameraVideo").srcObject = null;
  $("cameraView").hidden = true;
  $("cameraToggle").textContent = "Use camera";
  $("cameraMarker").hidden = true;
  if (message) $("cameraStatus").textContent = message;
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
  } catch (error) {
    console.error("Could not start camera view:", error);
    stopCameraView();
    $("cameraView").hidden = false;
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
      ${direction ? `<a class="text-link" href="${esc(direction)}" target="_blank" rel="noopener noreferrer">${currentPosition && coords ? "Get directions" : "View location"} <span aria-hidden="true">↗</span></a>` : (coords ? "" : '<p class="muted-note">Location coordinates not added yet.</p>')}
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
