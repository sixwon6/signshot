import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CaptureRecord, PhotoEdit } from "../../modules/seeker-camera";

const key = (record: CaptureRecord) => `es.photo-edit.v1:${record.baseName}`;

export async function readPhotoEdit(
  record: CaptureRecord,
): Promise<PhotoEdit | undefined> {
  const raw = await AsyncStorage.getItem(key(record));
  if (!raw) return undefined;
  const edit = JSON.parse(raw) as PhotoEdit;
  if (
    edit.sourceHash !== record.clean.sha256 ||
    typeof edit.uri !== "string" ||
    !/^[a-f0-9]{64}$/.test(edit.sha256) ||
    !Number.isFinite(edit.width) ||
    !Number.isFinite(edit.height)
  ) {
    throw new Error(
      "The saved photo version cannot be read. Your captured photo is still on this phone.",
    );
  }
  return edit;
}

export async function savePhotoEdit(
  record: CaptureRecord,
  edit?: PhotoEdit,
): Promise<void> {
  if (!edit) return AsyncStorage.removeItem(key(record));
  if (edit.sourceHash !== record.clean.sha256)
    throw new Error("This version belongs to a different photo.");
  await AsyncStorage.setItem(key(record), JSON.stringify(edit));
}
