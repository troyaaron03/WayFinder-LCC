import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { defaultRoomCoordinates } from "./campus-locations.js";

import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import { getFirestore, collection, addDoc, getDocs, doc, getDoc, updateDoc, deleteDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js";
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
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
const listUserAccountsCall = httpsCallable(functions, "listUserAccounts");
const setUserAccountRoleCall = httpsCallable(functions, "setUserAccountRole");

const $ = (id) => document.getElementById(id);
const modal = $("modal");
const form = $("form");
const title = $("title");
let managerRole = "";
let userPageToken = null;
let currentUserAccounts = [];

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = "index.html";
    return;
  }
  try {
    const profile = await getDoc(doc(db, "users", user.uid));
    if (!profile.exists() || !["admin", "superadmin"].includes(profile.data().role)) {
      alert("Admin access required.");
      await signOut(auth);
      location.href = "index.html";
      return;
    }
    managerRole = profile.data().role;
    $("users").querySelector("p").textContent = managerRole === "superadmin"
      ? "Manage registered accounts and assign roles."
      : "Manage student and visitor accounts. Only superadmins can assign admin or superadmin access.";
    loadFaculty();
    loadRooms();
    loadQrCodes();
    loadFeedback();
    loadTransactions();
    loadUserAccounts(true);
  } catch (error) {
    console.error(error);
    alert("Could not verify your admin profile. Check your Firestore rules.");
  }
});

$("logout").onclick = () => signOut(auth).then(() => location.href = "index.html");
$("close").onclick = () => modal.classList.add("hidden");
$("addFaculty").onclick = () => faculty();
$("addRoom").onclick = () => room();
$("addQrCode").onclick = () => qrCode();
$("refreshFeedback").onclick = () => loadFeedback();
$("refreshTransactions").onclick = () => loadTransactions();
$("refreshUsers").onclick = () => loadUserAccounts(true);
$("loadMoreUsers").onclick = () => loadUserAccounts(false);

document.querySelectorAll(".admin-nav button").forEach((button) => {
  button.onclick = () => {
    showTab(button.dataset.tab);
  };
});

function showTab(tabId) {
  document.querySelectorAll(".admin-nav button").forEach((button) => {
    const active = button.dataset.tab === tabId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll(".admin-main > section").forEach((section) => {
    section.classList.toggle("active", section.id === tabId);
  });
}

async function loadUserAccounts(reset) {
  const list = $("userList");
  const loadMore = $("loadMoreUsers");
  if (reset) {
    userPageToken = null;
    currentUserAccounts = [];
    $("userListNotice").hidden = true;
    list.innerHTML = '<p class="empty-state">Loading registered accounts…</p>';
  }
  $("refreshUsers").disabled = true;
  loadMore.disabled = true;
  try {
    const { data } = await listUserAccountsCall({ pageToken: userPageToken });
    currentUserAccounts = currentUserAccounts.concat(data.accounts || []);
    userPageToken = data.nextPageToken || null;
    renderUserAccounts();
    loadMore.hidden = !userPageToken;
  } catch (error) {
    console.error("Could not load user accounts:", error);
    if (!reset || userPageToken) {
      $("userListNotice").textContent = "Could not load the next page of Firebase Authentication accounts. Showing accounts loaded so far.";
      $("userListNotice").hidden = false;
      loadMore.hidden = true;
      return;
    }

    try {
      const profiles = await getDocs(collection(db, "users"));
      currentUserAccounts = profiles.docs.map((profile) => {
        const data = profile.data();
        return {
          uid: profile.id,
          email: data.email || "",
          role: ["student", "visitor", "admin", "superadmin"].includes(data.role) ? data.role : "student",
          studentNumber: data.studentNumber || ""
        };
      });
      renderUserAccounts();
      $("userListNotice").textContent = "Firebase Authentication account listing is unavailable. Showing accounts with Firestore profiles only; accounts without a profile may be missing. Deploy the latest Cloud Functions and ensure their runtime service account has Firebase Authentication Admin access.";
      $("userListNotice").hidden = false;
      loadMore.hidden = true;
    } catch (fallbackError) {
      console.error("Could not load user profiles from Firestore:", fallbackError);
      list.innerHTML = `<p class="error-text">Could not load accounts from Firebase Authentication or Firestore. Publish the latest Firestore rules and deploy the latest Cloud Functions. ${esc(fallbackError.message)}</p>`;
      loadMore.hidden = true;
    }
  } finally {
    $("refreshUsers").disabled = false;
    loadMore.disabled = false;
  }
}

function renderUserAccounts() {
  const list = $("userList");
  if (!currentUserAccounts.length) {
    list.innerHTML = '<p class="empty-state">No registered user accounts were found.</p>';
    return;
  }

  const currentUid = auth.currentUser?.uid;
  list.innerHTML = currentUserAccounts.map((account) => {
    const fixedRoleForAdmin = managerRole !== "superadmin" &&
      ["admin", "superadmin"].includes(account.role);
    const canEdit = account.uid !== currentUid && !fixedRoleForAdmin;
    const roles = managerRole === "superadmin"
      ? ["student", "visitor", "admin", "superadmin"]
      : ["student", "visitor"];
    return `<article class="card user-account-card">
      <span class="card-kicker">${esc(account.role.toUpperCase())}</span>
      <h3>${esc(account.email || "Email unavailable")}</h3>
      <p><strong>Student number:</strong> ${esc(account.studentNumber || "Not linked")}</p>
      <p class="user-account-id"><strong>Account ID:</strong> ${esc(account.uid)}</p>
      ${canEdit ? `<form class="user-role-form" data-user-id="${esc(account.uid)}">
        <label for="role-${esc(account.uid)}">Account role</label>
        <div class="user-role-controls">
          <select id="role-${esc(account.uid)}" name="role">
            ${roles.map((role) => `<option value="${role}" ${role === account.role ? "selected" : ""}>${role}</option>`).join("")}
          </select>
          <button type="submit">Save role</button>
        </div>
        <p class="user-role-message" role="status" aria-live="polite"></p>
      </form>` : `<p class="user-role-protection">${account.uid === currentUid ? "Your own role cannot be changed here." : "Only a superadmin can change this elevated role."}</p>`}
    </article>`;
  }).join("");

  list.querySelectorAll(".user-role-form").forEach((roleForm) => {
    roleForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const userId = roleForm.dataset.userId;
      const role = roleForm.elements.role.value;
      const button = roleForm.querySelector("button");
      const message = roleForm.querySelector(".user-role-message");
      button.disabled = true;
      message.textContent = "Saving role…";
      try {
        await setUserAccountRoleCall({ userId, role });
        message.textContent = "Role updated.";
        await loadUserAccounts(true);
      } catch (error) {
        console.error("Could not update account role:", error);
        message.textContent = error.code === "functions/permission-denied"
          ? "Your role cannot assign that account role."
          : error.code === "functions/failed-precondition"
            ? error.message
            : "Could not update this account. Check deployment and try again.";
        button.disabled = false;
      }
    });
  });
}

document.querySelectorAll("[data-quick-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.quickAction;
    if (action === "addFaculty") faculty();
    else if (action === "addRoom") room();
    else if (action === "addQrCode") qrCode();
  });
});

function setCount(elementId, count) {
  $(elementId).textContent = String(count);
}

function emptyState(icon, heading, description, actionId, actionLabel) {
  return `<div class="empty-panel"><span class="empty-icon" aria-hidden="true">${icon}</span>
    <h2>${heading}</h2><p>${description}</p>
    <button type="button" id="${actionId}">${actionLabel}</button></div>`;
}

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function val(id) {
  return $(id).value.trim();
}

// Free alternative to Firebase Storage: resize/compress the image in the browser
// and store it as a data URL in Firestore. Keep it under ~650 KB to stay safely
// below Firestore's 1 MiB document limit.
async function imageFileToDataUrl(file) {
  if (!file) return null;
  if (!file.type.startsWith("image/")) throw new Error("Please select an image file.");
  if (file.size > 10 * 1024 * 1024) throw new Error("The original image must be 10 MB or smaller.");

  const bitmap = await createImageBitmap(file);
  const maxDimension = 1200;
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // JPEG gives much smaller Firestore documents for photographs/floor plans.
  let quality = 0.82;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);

  while (dataUrl.length > 650000 && quality > 0.45) {
    quality -= 0.07;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  if (dataUrl.length > 700000) {
    throw new Error("This image is still too large after compression. Please choose a smaller image.");
  }

  return dataUrl;
}

function showImagePreview(inputId, previewId) {
  const input = $(inputId);
  const preview = $(previewId);
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) {
      preview.innerHTML = "";
      return;
    }
    if (!file.type.startsWith("image/")) {
      preview.innerHTML = '<span class="error-text">Please select an image file.</span>';
      input.value = "";
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      preview.innerHTML = '<span class="error-text">Original image must be 10 MB or smaller.</span>';
      input.value = "";
      return;
    }
    preview.innerHTML = "<span>Preparing preview...</span>";
    try {
      const dataUrl = await imageFileToDataUrl(file);
      preview.innerHTML = `<img src="${dataUrl}" alt="Selected image preview">`;
    } catch (error) {
      preview.innerHTML = `<span class="error-text">${esc(error.message)}</span>`;
      input.value = "";
    }
  });
}

function faculty(data = {}, id = null) {
  title.textContent = id ? "Edit Faculty" : "Add Faculty";
  form.innerHTML = `
    <label>Faculty Name *</label>
    <input id="name" required value="${esc(data.name)}">
    <label>Description</label>
    <textarea id="description">${esc(data.description)}</textarea>
    <label>Office / Location</label>
    <input id="location" value="${esc(data.location)}">
    <label>Contact</label>
    <input id="contact" value="${esc(data.contact)}">
    <label>Office Hours</label>
    <input id="hours" placeholder="08:00 AM - 05:00 PM" value="${esc(data.hours)}">
    <label>Faculty Image</label>
    <input id="imageFile" type="file" accept="image/*">
    <div id="imagePreview" class="image-preview">
      ${data.image ? `<img src="${esc(data.image)}" alt="Current faculty image">` : ""}
    </div>
    <small class="hint">Select an image for this faculty.</small>
    <label>Image URL (optional)</label>
    <input id="imageUrl" placeholder="Optional direct image URL" value="${esc(data.image && !data.image.startsWith("data:") ? data.image : "")}">
    <button class="save" id="saveFaculty" type="submit">Save Faculty</button>
  `;
  showImagePreview("imageFile", "imagePreview");

  form.onsubmit = async (event) => {
    event.preventDefault();
    const saveButton = $("saveFaculty");
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
    try {
      const file = $("imageFile").files?.[0];
      let image = data.image || "";
      const typedUrl = val("imageUrl");
      if (file) image = await imageFileToDataUrl(file);
      else if (typedUrl) image = typedUrl;

      const record = {
        name: val("name"),
        description: val("description"),
        location: val("location"),
        contact: val("contact"),
        hours: val("hours"),
        image,
        updatedAt: new Date().toISOString()
      };
      if (id) await updateDoc(doc(db, "faculties", id), record);
      else await addDoc(collection(db, "faculties"), record);
      modal.classList.add("hidden");
      await loadFaculty();
    } catch (error) {
      console.error(error);
      alert(`Could not save faculty: ${error.message}`);
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = "Save Faculty";
    }
  };
  modal.classList.remove("hidden");
}

function room(data = {}, id = null) {
  let defaultCoordinates = defaultRoomCoordinates(data);
  title.textContent = id ? "Edit Room" : "Add Room";
  form.innerHTML = `
    <label>Room Number *</label>
    <input id="roomNumber" required value="${esc(data.roomNumber)}">
    <label>Building</label>
    <input id="building" value="${esc(data.building)}">
    <label>Floor</label>
    <input id="floor" value="${esc(data.floor)}">
    <label>Latitude (optional)</label>
    <input id="latitude" type="number" step="any" min="-90" max="90"
      value="${esc(data.latitude ?? defaultCoordinates?.latitude ?? "")}" placeholder="e.g. 14.5995">
    <label>Longitude (optional)</label>
    <input id="longitude" type="number" step="any" min="-180" max="180"
      value="${esc(data.longitude ?? defaultCoordinates?.longitude ?? "")}" placeholder="e.g. 120.9842">
    <small class="hint">Add both coordinates to enable GPS distance and Google Maps directions for students. The Computer Lab default is 14.803056, 121.069722; verify its pin is at the correct entrance.</small>
    <label>Room Type</label>
    <input id="roomType" placeholder="Classroom, Laboratory, Office, etc." value="${esc(data.roomType)}">
    <label>Description</label>
    <textarea id="description">${esc(data.description)}</textarea>
    <label>Room / Floor Plan Image</label>
    <input id="mapFile" type="file" accept="image/*">
    <div id="mapPreview" class="image-preview">
      ${data.mapUrl ? `<img src="${esc(data.mapUrl)}" alt="Current room map">` : ""}
    </div>
    <small class="hint">Choose a room photo, floor plan, or map image. It will be automatically resized and compressed.</small>
    <label>Image URL (optional)</label>
    <input id="mapUrl" placeholder="Optional direct image URL" value="${esc(data.mapUrl && !data.mapUrl.startsWith("data:") ? data.mapUrl : "")}">
    <label>Direct Map URL (optional)</label>
    <input id="mapLink" placeholder="Google Maps, campus map page, etc." value="${esc(data.mapLink)}">
    <button class="save" id="saveRoom" type="submit">Save Room</button>
  `;
  ["roomNumber", "building", "roomType"].forEach((fieldId) => {
    $(fieldId).addEventListener("input", () => {
      const latitude = $("latitude");
      const longitude = $("longitude");
      const fieldsAreBlank = !latitude.value.trim() && !longitude.value.trim();
      const fieldsContainPreviousDefault = defaultCoordinates &&
        Number(latitude.value) === defaultCoordinates.latitude &&
        Number(longitude.value) === defaultCoordinates.longitude;
      if (!fieldsAreBlank && !fieldsContainPreviousDefault) return;

      defaultCoordinates = defaultRoomCoordinates({
        roomNumber: val("roomNumber"),
        building: val("building"),
        roomType: val("roomType")
      });
      latitude.value = defaultCoordinates ? String(defaultCoordinates.latitude) : "";
      longitude.value = defaultCoordinates ? String(defaultCoordinates.longitude) : "";
    });
  });
  showImagePreview("mapFile", "mapPreview");

  form.onsubmit = async (event) => {
    event.preventDefault();
    const saveButton = $("saveRoom");
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
    try {
      const file = $("mapFile").files?.[0];
      let mapUrl = data.mapUrl || "";
      const typedUrl = val("mapUrl");
      if (file) mapUrl = await imageFileToDataUrl(file);
      else if (typedUrl) mapUrl = typedUrl;

      const latitudeValue = val("latitude");
      const longitudeValue = val("longitude");
      if (Boolean(latitudeValue) !== Boolean(longitudeValue)) {
        throw new Error("Enter both latitude and longitude, or leave both blank.");
      }
      const latitude = latitudeValue ? Number(latitudeValue) : null;
      const longitude = longitudeValue ? Number(longitudeValue) : null;
      if ((latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) ||
          (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
        throw new Error("Enter valid coordinates: latitude -90 to 90 and longitude -180 to 180.");
      }
      const record = {
        roomNumber: val("roomNumber"),
        building: val("building"),
        floor: val("floor"),
        latitude,
        longitude,
        roomType: val("roomType"),
        description: val("description"),
        mapUrl,
        mapLink: val("mapLink"),
        updatedAt: new Date().toISOString()
      };
      if (id) await updateDoc(doc(db, "rooms", id), record);
      else await addDoc(collection(db, "rooms"), record);
      modal.classList.add("hidden");
      await loadRooms();
    } catch (error) {
      console.error(error);
      alert(`Could not save room: ${error.message}`);
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = "Save Room";
    }
  };
  modal.classList.remove("hidden");
}

async function loadFaculty() {
  try {
    const snapshot = await getDocs(collection(db, "faculties"));
    setCount("facultyCount", snapshot.size);
    $("facultyList").innerHTML = "";
    if (snapshot.empty) {
      $("facultyList").innerHTML = emptyState(
        "▦",
        "No faculties yet",
        "Add a faculty to share office locations, contact information, and hours with students.",
        "emptyAddFaculty",
        "Add your first faculty"
      );
      $("emptyAddFaculty").onclick = () => faculty();
      return;
    }
    snapshot.forEach((item) => {
      const data = item.data();
      $("facultyList").innerHTML += `
        <article class="card">
          ${data.image ? `<img class="card-image" src="${esc(data.image)}" alt="${esc(data.name)}">` : ""}
          <h3>${esc(data.name)}</h3>
          <p>${esc(data.description || "No description.")}</p>
          <p><b>Location:</b> ${esc(data.location || "-")}<br><b>Contact:</b> ${esc(data.contact || "-")}<br><b>Hours:</b> ${esc(data.hours || "-")}</p>
          <div class="actions">
            <button class="edit" data-edit-faculty="${item.id}">Edit</button>
            <button class="delete" data-delete-faculty="${item.id}">Delete</button>
          </div>
        </article>`;
    });
    document.querySelectorAll("[data-edit-faculty]").forEach((button) => {
      button.onclick = async () => {
        const item = await getDoc(doc(db, "faculties", button.dataset.editFaculty));
        if (item.exists()) faculty(item.data(), item.id);
      };
    });
    document.querySelectorAll("[data-delete-faculty]").forEach((button) => {
      button.onclick = async () => {
        if (!confirm("Delete this faculty?")) return;
        await deleteDoc(doc(db, "faculties", button.dataset.deleteFaculty));
        loadFaculty();
      };
    });
  } catch (error) {
    console.error(error);
    $("facultyList").innerHTML = `<p class="error-text">Could not load faculties: ${esc(error.message)}</p>`;
  }
}

async function loadRooms() {
  try {
    const snapshot = await getDocs(collection(db, "rooms"));
    setCount("roomCount", snapshot.size);
    $("roomList").innerHTML = "";
    if (snapshot.empty) {
      $("roomList").innerHTML = emptyState(
        "⌖",
        "No rooms yet",
        "Add room details and coordinates to help students find their destination.",
        "emptyAddRoom",
        "Add your first room"
      );
      $("emptyAddRoom").onclick = () => room();
      return;
    }
    snapshot.forEach((item) => {
      const data = item.data();
      $("roomList").innerHTML += `
        <article class="card">
          ${data.mapUrl ? `<img class="card-image" src="${esc(data.mapUrl)}" alt="Room ${esc(data.roomNumber)}">` : ""}
          <h3>Room ${esc(data.roomNumber)}</h3>
          <p><b>Building:</b> ${esc(data.building || "-")}<br><b>Floor:</b> ${esc(data.floor || "-")}<br><b>Type:</b> ${esc(data.roomType || "-")}<br><b>Coordinates:</b> ${data.latitude != null && data.longitude != null ? `${esc(data.latitude)}, ${esc(data.longitude)}` : "Not set"}</p>
          <p>${esc(data.description || "No description.")}</p>
          <div class="actions">
            <button class="edit" data-edit-room="${item.id}">Edit</button>
            <button class="delete" data-delete-room="${item.id}">Delete</button>
          </div>
        </article>`;
    });
    document.querySelectorAll("[data-edit-room]").forEach((button) => {
      button.onclick = async () => {
        const item = await getDoc(doc(db, "rooms", button.dataset.editRoom));
        if (item.exists()) room(item.data(), item.id);
      };
    });
    document.querySelectorAll("[data-delete-room]").forEach((button) => {
      button.onclick = async () => {
        if (!confirm("Delete this room?")) return;
        await deleteDoc(doc(db, "rooms", button.dataset.deleteRoom));
        loadRooms();
      };
    });
  } catch (error) {
    console.error(error);
    $("roomList").innerHTML = `<p class="error-text">Could not load rooms: ${esc(error.message)}</p>`;
  }
}

function qrCode(data = {}, id = null) {
  title.textContent = id ? "Edit QR guide" : "Add QR guide";
  const destination = data.targetUrl || data.pdfLink || "";

  form.innerHTML = `
    <label>Guide name *</label>
    <input id="qrName" required
      value="${esc(data.name || "")}"
      placeholder="Example: Building A — 2nd Floor">
    <label>Destination URL *</label>
    <input id="qrTargetUrl" type="url" required
      value="${esc(destination)}"
      placeholder="https://example.edu/campus-map">
    <small class="hint">A QR code is generated automatically for this link. Use a public HTTPS link for best results.</small>
    <div class="qr-preview"><div class="qr-preview-code" id="qrPreview"></div><p id="qrPreviewMessage" role="status">Enter a valid destination to preview its QR code.</p></div>
    <button class="save" type="submit">Save QR guide</button>
  `;

  const previewQr = () => {
    const preview = $("qrPreview");
    const message = $("qrPreviewMessage");
    const link = val("qrTargetUrl");
    preview.replaceChildren();
    if (!link) {
      message.textContent = "Enter a destination URL to preview its QR code.";
      return;
    }
    if (!isValidWebLink(link)) {
      message.textContent = "Use a complete HTTP or HTTPS destination URL.";
      return;
    }
    if (!window.QRCode) {
      message.textContent = "QR preview library could not load. The destination can still be saved.";
      return;
    }
    new window.QRCode(preview, {
      text: link,
      width: 108,
      height: 108,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: window.QRCode.CorrectLevel.M
    });
    message.textContent = "This code opens the destination shown above.";
  };
  $("qrTargetUrl").addEventListener("input", previewQr);
  previewQr();

  form.onsubmit = async (event) => {
    event.preventDefault();

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = "Saving…";

    try {
      const targetUrl = val("qrTargetUrl");
      if (!isValidWebLink(targetUrl)) {
        throw new Error("Please enter a valid HTTP or HTTPS destination URL.");
      }

      const record = {
        name: val("qrName").trim(),
        targetUrl,
        pdfLink: targetUrl
      };

      if (id) {
        await updateDoc(doc(db, "qrCodes", id), record);
      } else {
        await addDoc(collection(db, "qrCodes"), record);
      }

      modal.classList.add("hidden");
      await loadQrCodes();
    } catch (error) {
      console.error(error);
      alert("Could not save the QR guide: " + error.message);
    } finally {
      button.disabled = false;
      button.textContent = "Save QR guide";
    }
  };

  modal.classList.remove("hidden");
}

function isValidWebLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function loadQrCodes() {
  const list = $("qrCodeList");
  list.innerHTML = "<p>Loading QR codes...</p>";

  try {
    const snapshot = await getDocs(collection(db, "qrCodes"));
    setCount("qrCount", snapshot.size);
    list.innerHTML = "";

    if (snapshot.empty) {
      list.innerHTML = emptyState(
        "▧",
        "No QR guides yet",
        "Create a scannable link to a campus map, floor plan, or helpful resource.",
        "emptyAddQrCode",
        "Create your first QR guide"
      );
      $("emptyAddQrCode").onclick = () => qrCode();
      return;
    }

    snapshot.forEach((item) => {
      const data = item.data();
      const target = data.targetUrl || data.pdfLink || "";
      const safeTarget = isValidWebLink(target) ? target : "";

      list.innerHTML += `
        <article class="card">
          <div class="qr-preview"><div class="qr-preview-code" id="admin-qr-${esc(item.id)}"></div>
            <p>${esc(target || "No destination link")}</p></div>
          <h3>${esc(data.name)}</h3>
          ${safeTarget ? `<p><a href="${esc(safeTarget)}" target="_blank" rel="noopener noreferrer">Open destination</a></p>` : '<p class="error-text">Destination URL is invalid.</p>'}

          <div class="actions">
            <button class="edit"
              data-edit-qr="${item.id}">Edit</button>

            <button class="delete"
              data-delete-qr="${item.id}">Delete</button>
          </div>
        </article>
          `;
    });

    if (window.QRCode) {
      snapshot.forEach((item) => {
        const target = item.data().targetUrl || item.data().pdfLink || "";
        if (!isValidWebLink(target)) return;
        const container = $(`admin-qr-${item.id}`);
        if (container) {
          new window.QRCode(container, {
            text: target,
            width: 108,
            height: 108,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: window.QRCode.CorrectLevel.M
          });
        }
      });
    }

    document.querySelectorAll("[data-edit-qr]").forEach((button) => {
      button.onclick = async () => {
        const item = await getDoc(
          doc(db, "qrCodes", button.dataset.editQr)
        );

        if (item.exists()) {
          qrCode(item.data(), item.id);
        }
      };
    });

    document.querySelectorAll("[data-delete-qr]").forEach((button) => {
      button.onclick = async () => {
        if (!confirm("Delete this QR code?")) return;

        await deleteDoc(doc(db, "qrCodes", button.dataset.deleteQr));
        await loadQrCodes();
      };
    });
  } catch (error) {
    console.error(error);
    list.innerHTML =
      `<p class="error-text">Could not load QR codes: ${esc(error.message)}</p>`;
  }
}

async function loadFeedback() {
  const list = $("feedbackList");
  list.innerHTML = "<p>Loading student feedback...</p>";

  try {
    const feedbackQuery = query(
      collection(db, "feedback"),
      orderBy("createdAt", "desc")
    );

    const snapshot = await getDocs(feedbackQuery);
    setCount("feedbackCount", snapshot.size);

    if (snapshot.empty) {
      list.innerHTML = emptyState(
        "✳",
        "No feedback yet",
        "Student ratings and suggestions will appear here when they are submitted.",
        "emptyRefreshFeedback",
        "Refresh feedback"
      );
      $("emptyRefreshFeedback").onclick = () => loadFeedback();
      return;
    }

    list.innerHTML = "";

    snapshot.forEach((item) => {
      const data = item.data();

      const rating = Math.max(
        0,
        Math.min(5, Number(data.rating) || 0)
      );

      const date = data.createdAt?.toDate
        ? data.createdAt.toDate().toLocaleString()
        : "Date unavailable";

      list.innerHTML += `
        <article class="card">
          <h3>Student rating</h3>

          <p>
            <strong>Rating:</strong>
            <span aria-label="${rating} out of 5 stars">
              ${"★".repeat(rating)}${"☆".repeat(5 - rating)}
            </span>
            (${rating}/5)
          </p>

          <p>
            <strong>Comment:</strong>
            ${esc(data.comment || "No comment provided.")}
          </p>

          <p>
            <strong>Submitted:</strong>
            ${esc(date)}
          </p>

          <p>
            <strong>Student ID:</strong>
            ${esc(data.userId || "Unavailable")}
          </p>
        </article>
      `;
    });
  } catch (error) {
    console.error("Could not load feedback:", error);
    list.innerHTML = `
      <p class="error-text">
        Could not load feedback: ${esc(error.message)}
      </p>
    `;
  }
}

async function loadTransactions() {
  const list = $("transactionList");
  list.innerHTML = "<p>Loading destination visits...</p>";
  try {
    const snapshot = await getDocs(query(collection(db, "transactions"), orderBy("createdAt", "desc")));
    if (snapshot.empty) {
      list.innerHTML = '<p class="empty-state">No destination visits have been recorded yet.</p>';
      return;
    }

    list.innerHTML = snapshot.docs.map((item) => {
      const data = item.data();
      const date = data.createdAt?.toDate ? data.createdAt.toDate().toLocaleString() : "Date unavailable";
      return `<article class="card">
        <span class="card-kicker">${data.method === "camera" ? "CONFIRMED ARRIVAL" : "MAP DIRECTIONS"}</span>
        <h3>${esc(data.building || "Campus")} · ${esc(data.roomNumber || "Room unavailable")}</h3>
        <p><strong>Student number:</strong> ${esc(data.studentNumber || "Unavailable")}</p>
        <p><strong>Recorded:</strong> ${esc(date)}</p>
      </article>`;
    }).join("");
  } catch (error) {
    console.error("Could not load destination visits:", error);
    list.innerHTML = `<p class="error-text">Could not load destination visits: ${esc(error.message)}</p>`;
  }
}
