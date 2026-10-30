
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";

import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

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

const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const msg = document.getElementById("msg");
const formTitle = document.getElementById("formTitle");
const formDescription = document.getElementById("formDescription");

function setMessage(message, state = "error") {
  msg.textContent = message;
  msg.dataset.state = state;
}

function clearMessage() {
  setMessage("", "error");
}

document.getElementById("showRegister").addEventListener("click", () => {
  loginForm.hidden = true;
  registerForm.hidden = false;
  formTitle.textContent = "Create your account";
  formDescription.textContent = "Register with your campus email to get started.";
  clearMessage();
});

document.getElementById("showLogin").addEventListener("click", () => {
  registerForm.hidden = true;
  loginForm.hidden = false;
  formTitle.textContent = "Sign in";
  formDescription.textContent = "Use your campus account to continue.";
  clearMessage();
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  setMessage("Signing in…", "success");

  try {
    const credential = await signInWithEmailAndPassword(
      auth, email, password
    );

    const profile = await getDoc(
      doc(db, "users", credential.user.uid)
    );

    if (!profile.exists()) {
      setMessage("Your account has no user profile. Please contact the administrator.");
      return;
    }

    const role = profile.data().role;

    if (role === "admin") {
      window.location.href = "admin.html";
    } else if (role === "student") {
      window.location.href = "dashboard.html";
    } else {
      setMessage("Your account role is not recognized.");
    }
  } catch (error) {
    console.error("Login error:", error);

    if (
      error.code === "auth/invalid-credential" ||
      error.code === "auth/wrong-password" ||
      error.code === "auth/user-not-found"
    ) {
      setMessage("Incorrect email or password.");
    } else if (error.code === "permission-denied") {
      setMessage("Firestore permission denied. Check your security rules.");
    } else {
      setMessage(`Login failed: ${error.message}`);
    }
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = document.getElementById("registerEmail").value.trim();
  const password = document.getElementById("registerPassword").value;
  const confirmPassword =
    document.getElementById("confirmPassword").value;

  if (password.length < 6) {
    setMessage("Password must contain at least 6 characters.");
    return;
  }

  if (password !== confirmPassword) {
    setMessage("Passwords do not match.");
    return;
  }

  setMessage("Creating your student account…", "success");

  let createdUser = null;

  try {
    const credential = await createUserWithEmailAndPassword(
      auth, email, password
    );

    createdUser = credential.user;

    // Every public registration is assigned the student role.
    await setDoc(doc(db, "users", createdUser.uid), {
      email: createdUser.email,
      role: "student",
      createdAt: serverTimestamp()
    });

    setMessage("Registration successful! Opening your student dashboard…", "success");

    window.location.href = "dashboard.html";
  } catch (error) {
    console.error("Registration error:", error);

    if (createdUser) {
      setMessage("Your authentication account was created, but the student profile could not be saved. Please contact the administrator before trying to register again.");
    } else if (error.code === "auth/email-already-in-use") {
      setMessage("This email is already registered. Please log in.");
    } else if (error.code === "auth/invalid-email") {
      setMessage("Please enter a valid email address.");
    } else if (error.code === "auth/weak-password") {
      setMessage("Please choose a stronger password.");
    } else {
      setMessage(`Registration failed: ${error.message}`);
    }
  }
});
