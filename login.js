
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";

import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import { getFunctions } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { linkStudentNumber } from "./student-account.js";

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
  formDescription.textContent = "Register with your student number and campus email.";
  clearMessage();
});

document.getElementById("showLogin").addEventListener("click", () => {
  registerForm.hidden = true;
  loginForm.hidden = false;
  formTitle.textContent = "Sign in";
  formDescription.textContent = "Use your campus email to continue.";
  clearMessage();
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  setMessage("Signing in…", "success");

  let credential;
  try {
    credential = await signInWithEmailAndPassword(auth, email, password);

    const user = credential.user;

    const profile = await getDoc(
      doc(db, "users", user.uid)
    );

    const profileData = profile.exists() ? profile.data() : null;
    if (profileData?.role === "admin" || profileData?.role === "superadmin") {
      window.location.href = "admin.html";
      return;
    }
    if (profileData?.role === "student") {
      const studentNumber = String(profileData?.studentNumber || "") ||
          localStorage.getItem(`pendingStudentNumber:${user.uid}`) || "";
      if (profileData.studentNumber) {
      }
      if (studentNumber) {
        try {
          await linkStudentNumber(db, functions, user, studentNumber);
          localStorage.removeItem(`pendingStudentNumber:${user.uid}`);
          sessionStorage.removeItem("studentNumberLinkNotice");
        } catch (error) {
          console.error("Could not complete student-number account setup:", error);
          const message = error.code === "functions/already-exists"
            ? "You’re signed in with email, but this student number is already linked to another account. Contact the administrator to resolve it."
            : "You’re signed in with email, but student-number setup could not finish. Contact the administrator if you need arrival tracking.";
          sessionStorage.setItem("studentNumberLinkNotice", message);
        }
      }
    } else if (!profileData) {
      const pendingNumber = localStorage.getItem(`pendingStudentNumber:${user.uid}`) ||
        "";
      if (pendingNumber) {
        try {
          await linkStudentNumber(db, functions, user, pendingNumber);
          localStorage.removeItem(`pendingStudentNumber:${user.uid}`);
          sessionStorage.removeItem("studentNumberLinkNotice");
        } catch (error) {
          console.error("Could not complete student-number account setup:", error);
          sessionStorage.setItem(
            "studentNumberLinkNotice",
            "You’re signed in with email, but account setup is not complete. The administrator may need to deploy the setup function and update Firestore rules."
          );
        }
      } else {
        sessionStorage.setItem(
          "studentNumberLinkNotice",
          "You’re signed in with email. Student account setup is incomplete; contact the administrator to finish linking your student number."
        );
      }
    } else if (profileData.role !== "visitor") {
      setMessage("Your account profile is missing or has an invalid role. Contact the administrator.", "error");
      await signOut(auth);
      return;
    }

    window.location.href = "dashboard.html";
  } catch (error) {
    console.error("Login error:", error);

    if (
      error.code === "auth/invalid-credential" ||
      error.code === "auth/wrong-password" ||
      error.code === "auth/user-not-found"
    ) {
      setMessage("Incorrect email or password.");
    } else if (error.code === "permission-denied") {
      console.error("Firestore denied sign-in profile access:", error);
      setMessage("Could not load your account profile. Ask the administrator to check Firestore access rules.");
    } else {
      setMessage(`Login failed: ${error.message}`);
    }
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const studentNumber = document.getElementById("studentNumber").value.trim();
  const email = document.getElementById("registerEmail").value.trim();
  const password = document.getElementById("registerPassword").value;
  const confirmPassword =
    document.getElementById("confirmPassword").value;

  if (!/^\d{8}$/.test(studentNumber)) {
    setMessage("Student number must contain exactly 8 digits.");
    return;
  }

  if (password.length < 8 || !/[A-Z]/.test(password)) {
    setMessage("Password must contain at least 8 characters and 1 uppercase letter.");
    return;
  }

  if (password !== confirmPassword) {
    setMessage("Passwords do not match.");
    return;
  }

  setMessage("Creating your student account…", "success");

  let createdUser = null;
  let studentProfileLinked = false;
  try {
    const credential = await createUserWithEmailAndPassword(
      auth, email, password
    );

    createdUser = credential.user;
    localStorage.setItem(`pendingStudentNumber:${createdUser.uid}`, studentNumber);
    try {
      await linkStudentNumber(db, functions, createdUser, studentNumber);
      localStorage.removeItem(`pendingStudentNumber:${createdUser.uid}`);
      studentProfileLinked = true;
    } catch (setupError) {
      console.error("Account created, but student profile setup failed:", setupError);
    }
    await signOut(auth);
    registerForm.reset();
    loginForm.hidden = false;
    registerForm.hidden = true;
    formTitle.textContent = "Sign in";
    formDescription.textContent = "Use your campus email to continue.";
    setMessage(
      studentProfileLinked
        ? "Account created. You can now sign in with your campus email."
        : "Account created. Sign in with your campus email, then link your student number from the dashboard.",
      "success"
    );
  } catch (error) {
    console.error("Registration error:", error);

    if (createdUser && auth.currentUser) {
      try {
        await signOut(auth);
      } catch (cleanupError) {
        console.error("Could not sign out after registration:", cleanupError);
      }
    }

    if (createdUser) {
      setMessage("Your account was created, but setup could not finish. Sign in with your email and link your student number from the dashboard.");
    } else if (error.code === "auth/email-already-in-use") {
      setMessage("This email is already registered. Please log in.");
    } else if (error.code === "auth/invalid-email") {
      setMessage("Please enter a valid email address.");
    } else if (error.code === "auth/weak-password") {
      setMessage("Password must contain at least 8 characters and 1 uppercase letter.");
    } else {
      setMessage(`Registration failed: ${error.message}`);
    }
  }
});
