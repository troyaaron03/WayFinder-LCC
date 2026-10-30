export const COMPUTER_LAB_COORDINATES = Object.freeze({
  latitude: 14.8030556,
  longitude: 121.0697222
});

export function defaultRoomCoordinates(room = {}) {
  const placeName = [room.building, room.roomNumber, room.name, room.roomType]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  if (placeName.includes("comlab") ||
      placeName.includes("computerlab") ||
      placeName.includes("computerlaboratory")) {
    return COMPUTER_LAB_COORDINATES;
  }
  return null;
}
