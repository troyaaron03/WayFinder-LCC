CAMPUS WAYFINDER

A responsive campus directory and navigation app built with HTML, CSS, and
JavaScript modules. It keeps the existing Firebase Authentication and Firestore
setup and uses Tailwind CSS for the browser UI.

FIREBASE SETUP
1. Enable Email/Password in Firebase Authentication.
2. Create a Firestore database.
3. Add an administrator document at users/{UID} with role = admin.
4. Publish firestore.rules from this folder.

RUN
Open the cns folder in VS Code and use Live Server on index.html. The Tailwind
browser build and QR renderer are loaded from public CDNs, so an internet
connection is needed. The browser-based Tailwind build is convenient for this
static prototype; use a compiled Tailwind build before production deployment.

BRANDING ASSETS
Keep assets/campus-logo.jpg and assets/campus-building.jpg in place when
deploying. The full college logo appears in the app header; the campus photo is
used on room cards that do not have their own image.

ROOMS AND GPS DIRECTIONS
Administrators can add a latitude and longitude to a room in Rooms & locations.
Both coordinates are required together. Coordinates are optional; rooms without
them remain available in the directory. Students can select Use my location to
request a one-time browser location reading, see nearby rooms first, and open a
Google Maps route. GPS requires the user's permission and a secure context (HTTPS
or localhost). A student's location is held in page memory only and is not
written to Firebase. It is included in a Google Maps link only if the student
chooses to open directions.

3D CAMPUS VIEW
The student map includes an interactive schematic 3D view generated from room
records. Buildings with coordinates are positioned relative to one another;
records without coordinates are shown in an illustrative layout. The building
shapes are placeholders, not surveyed or architecturally accurate models. The
view uses Three.js from a public CDN, so an internet connection is required.
For a true campus replica or indoor navigation, provide surveyed building
coordinates and custom 3D models or floor plans.

CAMERA GUIDANCE
Students may opt in to a live camera view from the map page. The browser asks
for camera permission only after the student chooses Use camera; compatible
devices may also ask for compass/orientation permission. Camera video is shown
locally and is not recorded or uploaded. Camera access requires HTTPS or
localhost. The destination indicator is approximate and depends on device
location, compass support, and accurate room coordinates; it is not a
camera-anchored AR route. Students can still use the map without granting
camera or location access.

QR GUIDES
Administrators add a guide name and an HTTP/HTTPS destination. The app generates
the QR image in the browser; no image upload or QR image storage is needed.
Existing QR records with a pdfLink continue to work.

IMAGES
Faculty and room images are resized/compressed in the browser and stored as data
URLs in Firestore documents. Original images may be up to 10 MB; the compressed
image is kept below approximately 700 KB. This is suitable for a modest
prototype, not a large production image library.

IMPORTANT
Keep Firestore Security Rules enabled. Students can submit feedback and read
campus information; only admins can manage campus records or read feedback.
Do not put passwords in project files.
