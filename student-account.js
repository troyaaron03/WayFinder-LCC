import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js";
import {
  doc,
  getDoc,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

export async function linkStudentNumber(db, functions, user, studentNumber) {
  if (!/^\d{8}$/.test(studentNumber)) {
    throw new Error("Student number must contain exactly 8 digits.");
  }

  try {
    const completeSetup = httpsCallable(functions, "completeStudentNumberSetup");
    await completeSetup({ studentNumber });
    return;
  } catch (error) {
    if (!["functions/not-found", "functions/internal", "functions/unavailable"].includes(error.code)) {
      throw error;
    }
    console.warn("Account setup function is unavailable; trying the Firestore rules-validated setup.", error);
  }

  const userRef = doc(db, "users", user.uid);
  const profile = await getDoc(userRef);
  const profileData = profile.exists() ? profile.data() : null;

  if (profileData && (profileData.role !== "student" ||
      (profileData.studentNumber && profileData.studentNumber !== studentNumber))) {
    const error = new Error("This account cannot be linked to that student number.");
    error.code = "student-number/invalid-profile";
    throw error;
  }
  if (profileData?.studentNumber === studentNumber) return;
  if (!user.email) {
    const error = new Error("This account needs an email address before linking a student number.");
    error.code = "student-number/email-not-verified";
    throw error;
  }

  const batch = writeBatch(db);
  if (profileData) {
    batch.update(userRef, { studentNumber });
  } else {
    batch.set(userRef, {
      email: user.email,
      role: "student",
      studentNumber,
      createdAt: serverTimestamp()
    });
  }
  batch.set(doc(db, "studentNumbers", studentNumber), { userId: user.uid });
  await batch.commit();

  const confirmedProfile = await getDoc(userRef);
  if (!confirmedProfile.exists() || confirmedProfile.data().studentNumber !== studentNumber) {
    throw new Error("Student-number setup could not be confirmed.");
  }
}
