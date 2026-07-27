const COLLAPSED_SESSION_FOLDERS_STORAGE_KEY = "joyshell:collapsed-session-folders:v1";

export function loadCollapsedSessionFolders() {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_SESSION_FOLDERS_STORAGE_KEY);
    if (!raw) {
      return new Set<string>();
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set<string>();
  }
}

export function saveCollapsedSessionFolders(folderIds: Set<string>) {
  try {
    window.localStorage.setItem(
      COLLAPSED_SESSION_FOLDERS_STORAGE_KEY,
      JSON.stringify(Array.from(folderIds))
    );
  } catch {
    // Local storage can be unavailable in restricted preview contexts.
  }
}
