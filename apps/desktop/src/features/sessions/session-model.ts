import type { LayoutSettings, SessionFolder, SessionProfile } from "../../types";

export type SidebarSortMode = "custom" | "name" | "host";

export type ProfileDoubleClickDecision =
  | { kind: "activate"; shellId: string }
  | { kind: "create" }
  | { kind: "connect"; shellId?: string };

export function resolveProfileDoubleClickDecision({
  profileId,
  openShellIds,
  shellProfileIds,
  connectedSessionIds,
  action
}: {
  profileId: string;
  openShellIds: string[];
  shellProfileIds: Record<string, string>;
  connectedSessionIds: ReadonlySet<string>;
  action: LayoutSettings["connected_profile_double_click_action"];
}): ProfileDoubleClickDecision {
  const profileShellIds = openShellIds.filter(
    (shellId) => (shellProfileIds[shellId] ?? shellId) === profileId
  );
  const earliestConnectedShellId = profileShellIds.find((shellId) => connectedSessionIds.has(shellId));

  if (earliestConnectedShellId) {
    return action === "new_session"
      ? { kind: "create" }
      : { kind: "activate", shellId: earliestConnectedShellId };
  }

  return { kind: "connect", shellId: profileShellIds[0] };
}

export function createBlankProfile(name = "新建服务器", group: string | null = null): SessionProfile {
  return {
    id: crypto.randomUUID(),
    name,
    group,
    host: "",
    port: 22,
    latency_probe_host: null,
    latency_probe_port: null,
    use_terminal_latency_probe: false,
    operating_system: null,
    username: "",
    tags: [],
    favorite: false,
    sort_order: 0
  };
}

export function createUniqueBlankProfile(profiles: SessionProfile[], group: string | null = null): SessionProfile {
  const nextOrder = profiles.reduce((max, profile) => Math.max(max, profile.sort_order ?? 0), -1) + 1;
  return { ...createBlankProfile(createUniqueProfileName(profiles, "新建服务器"), group), sort_order: nextOrder };
}

export function createUniqueProfileName(profiles: SessionProfile[], baseName: string) {
  const existingNames = new Set(profiles.map((profile) => profile.name.trim()).filter(Boolean));
  if (!existingNames.has(baseName)) {
    return baseName;
  }
  let index = 1;
  while (existingNames.has(`${baseName}${index}`)) {
    index += 1;
  }
  return `${baseName}${index}`;
}

export function createUniqueFolderName(folders: SessionFolder[], baseName: string) {
  const existingNames = new Set(folders.map((folder) => folder.name.trim()).filter(Boolean));
  if (!existingNames.has(baseName)) {
    return baseName;
  }
  let index = 1;
  while (existingNames.has(`${baseName}${index}`)) {
    index += 1;
  }
  return `${baseName}${index}`;
}

export function resolveStartupLayout(settings: LayoutSettings) {
  return settings.restore_last_layout
    ? {
        leftSidebarOpen: settings.last_left_sidebar_open,
        rightSidebarOpen: settings.last_right_sidebar_open,
        bottomPanelOpen: settings.last_bottom_panel_open
      }
    : {
        leftSidebarOpen: settings.default_left_sidebar_open,
        rightSidebarOpen: settings.default_right_sidebar_open,
        bottomPanelOpen: settings.default_bottom_panel_open
      };
}

export function buildProfileGroups(profiles: SessionProfile[], folders: SessionFolder[], sortMode: SidebarSortMode) {
  const folderGroups = folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    profiles: sortProfilesForSidebar(profiles.filter((profile) => profile.group === folder.name), sortMode)
  }));
  const folderNames = new Set(folders.map((folder) => folder.name));
  const looseProfiles = profiles.filter((profile) => !profile.group || !folderNames.has(profile.group));
  folderGroups.push({
    id: "ungrouped",
    name: "独立服务器",
    profiles: sortProfilesForSidebar(looseProfiles, sortMode)
  });
  return folderGroups;
}

export function profileMatchesSearch(
  profile: SessionProfile,
  query: string,
  folderNameByProfileGroup: Map<string, string>
) {
  const folderName = profile.group ? folderNameByProfileGroup.get(profile.group) ?? profile.group : "独立服务器";
  const haystack = [
    profile.name,
    profile.host,
    String(profile.port),
    profile.username,
    folderName,
    ...profile.tags
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

export function sortProfilesForSidebar(profiles: SessionProfile[], sortMode: SidebarSortMode) {
  return [...profiles].sort((left, right) => {
    if (left.favorite !== right.favorite) {
      return Number(right.favorite) - Number(left.favorite);
    }
    if (sortMode === "name") {
      return left.name.localeCompare(right.name, "zh-Hans-CN") || left.host.localeCompare(right.host);
    }
    if (sortMode === "host") {
      return left.host.localeCompare(right.host) || left.name.localeCompare(right.name, "zh-Hans-CN");
    }
    return (left.sort_order ?? 0) - (right.sort_order ?? 0) || left.name.localeCompare(right.name, "zh-Hans-CN");
  });
}

export function normalizeProfileSortOrders(profiles: SessionProfile[]) {
  const groupOrder = new Map<string, number>();
  return profiles.map((profile) => {
    const key = profile.group ?? "__ungrouped__";
    const nextOrder = groupOrder.get(key) ?? 0;
    groupOrder.set(key, nextOrder + 1);
    return { ...profile, sort_order: nextOrder };
  });
}

export function getProfileGroupName(profile: SessionProfile | undefined, folders: SessionFolder[]) {
  if (!profile?.group || !folders.some((folder) => folder.name === profile.group)) {
    return null;
  }
  return profile.group;
}

export function groupNameFromGroupId(groupId: string | null | undefined, folders: SessionFolder[]) {
  if (!groupId || groupId === "ungrouped") {
    return null;
  }
  return folders.find((folder) => folder.id === groupId)?.name ?? null;
}

export function reorderProfileByPointer(
  profiles: SessionProfile[],
  folders: SessionFolder[],
  draggedId: string,
  targetId: string | null,
  targetGroupId: string | null,
  clientY: number
) {
  const dragged = profiles.find((profile) => profile.id === draggedId);
  if (!dragged) {
    return profiles;
  }
  const target = targetId ? profiles.find((profile) => profile.id === targetId) : null;
  const targetGroupName = target ? getProfileGroupName(target, folders) : groupNameFromGroupId(targetGroupId, folders);
  const draggedGroupName = getProfileGroupName(dragged, folders);
  if (targetId === draggedId && targetGroupName === draggedGroupName) {
    return profiles;
  }

  const withoutDragged = profiles.filter((profile) => profile.id !== draggedId);
  const moved = { ...dragged, group: targetGroupName };
  let insertIndex = withoutDragged.length;
  if (target) {
    const targetElement = document.querySelector<HTMLElement>(`[data-session-profile-id="${target.id}"]`);
    const targetIndex = withoutDragged.findIndex((profile) => profile.id === target.id);
    if (targetIndex >= 0) {
      const rect = targetElement?.getBoundingClientRect();
      const placeAfter = rect ? clientY > rect.top + rect.height / 2 : false;
      insertIndex = targetIndex + (placeAfter ? 1 : 0);
    }
  } else if (targetGroupId) {
    const lastInGroup = withoutDragged
      .map((profile, index) => ({ profile, index }))
      .filter((item) => getProfileGroupName(item.profile, folders) === targetGroupName)
      .at(-1);
    insertIndex = lastInGroup ? lastInGroup.index + 1 : withoutDragged.length;
  }

  const next = [...withoutDragged];
  next.splice(insertIndex, 0, moved);
  return normalizeProfileSortOrders(next);
}

export function moveProfileWithinCurrentGroup(
  profiles: SessionProfile[],
  profileId: string,
  action: "up" | "down" | "top" | "bottom"
) {
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) {
    return profiles;
  }
  const group = profile.group ?? null;
  const sameGroup = sortProfilesForSidebar(profiles.filter((item) => (item.group ?? null) === group), "custom");
  const index = sameGroup.findIndex((item) => item.id === profileId);
  if (index < 0) {
    return profiles;
  }
  const reordered = [...sameGroup];
  const [item] = reordered.splice(index, 1);
  const targetIndex = action === "top"
    ? 0
    : action === "bottom"
      ? reordered.length
      : action === "up"
        ? Math.max(0, index - 1)
        : Math.min(reordered.length, index + 1);
  reordered.splice(targetIndex, 0, item);
  const orderById = new Map(reordered.map((profileItem, order) => [profileItem.id, order]));
  const reorderedById = new Map(reordered.map((profileItem) => [profileItem.id, profileItem]));
  const replacementQueue = reordered.map((profileItem) => ({
    ...profileItem,
    sort_order: orderById.get(profileItem.id) ?? profileItem.sort_order
  }));
  return profiles.map((profileItem) => (
    reorderedById.has(profileItem.id)
      ? replacementQueue.shift() ?? profileItem
      : profileItem
  ));
}

export function findProfileDropIndicator(clientX: number, clientY: number, draggedId: string) {
  const elements = document.elementsFromPoint(clientX, clientY);
  const targetGroup = elements
    .map((element) => element.closest("[data-session-group-id]") as HTMLElement | null)
    .find(Boolean);
  if (!targetGroup) {
    return null;
  }
  const targetRow = elements
    .map((element) => element.closest("[data-session-profile-id]") as HTMLElement | null)
    .find((element) => Boolean(element) && element?.dataset.sessionProfileId !== draggedId);
  if (!targetRow) {
    return {
      groupId: targetGroup.dataset.sessionGroupId ?? null,
      targetId: null,
      position: "inside" as const,
      clientY
    };
  }
  const rect = targetRow.getBoundingClientRect();
  return {
    groupId: targetGroup.dataset.sessionGroupId ?? null,
    targetId: targetRow.dataset.sessionProfileId ?? null,
    position: clientY > rect.top + rect.height / 2 ? "after" as const : "before" as const,
    clientY
  };
}

export function findTabDropIndicator(clientX: number, draggedId: string) {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>("[data-tab-profile-id]"))
    .filter((element) => element.dataset.tabProfileId !== draggedId);
  if (tabs.length === 0) {
    return { targetId: null, position: "after" as const };
  }
  for (const tab of tabs) {
    const rect = tab.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      return { targetId: tab.dataset.tabProfileId ?? null, position: "before" as const };
    }
  }
  return { targetId: tabs.at(-1)?.dataset.tabProfileId ?? null, position: "after" as const };
}

export function resolveProfileOperatingSystem(profile: SessionProfile) {
  const osName = profile.operating_system?.trim() ?? "";
  const normalized = osName.toLowerCase();
  if (normalized.includes("windows")) {
    return { label: "Windows", shortLabel: "WIN", tone: "windows", symbolId: "icon-windows" };
  }
  if (normalized.includes("macos") || normalized.includes("mac os") || normalized.includes("darwin")) {
    return { label: "macOS", shortLabel: "MAC", tone: "mac", symbolId: "icon-macos" };
  }
  if (normalized.includes("ubuntu")) {
    return { label: "Ubuntu", shortLabel: "UBU", tone: "linux", symbolId: "icon-Ubuntu" };
  }
  if (normalized.includes("alpine")) {
    return { label: "Alpine", shortLabel: "ALP", tone: "linux", symbolId: "icon-alpine" };
  }
  if (normalized.includes("centos")) {
    return { label: "CentOS", shortLabel: "COS", tone: "linux", symbolId: "icon-centos-stream" };
  }
  if (normalized.includes("fedora")) {
    return { label: "Fedora", shortLabel: "FED", tone: "linux", symbolId: "icon-fedora" };
  }
  if (normalized.includes("freebsd")) {
    return { label: "FreeBSD", shortLabel: "BSD", tone: "bsd", symbolId: "icon-freebsd" };
  }
  if (
    normalized.includes("red hat")
    || normalized.includes("rhel")
    || normalized.includes("rocky")
    || normalized.includes("alma")
    || normalized.includes("oracle linux")
  ) {
    return { label: osName || "Red Hat", shortLabel: "RHL", tone: "linux", symbolId: "icon-icon-test" };
  }
  if (normalized.includes("debian")) {
    return { label: "Debian", shortLabel: "DEB", tone: "linux", symbolId: null };
  }
  if (normalized.includes("linux")) {
    return { label: osName || "Linux", shortLabel: "LIN", tone: "linux", symbolId: null };
  }
  return { label: osName || "Unknown OS", shortLabel: "OS", tone: "unknown", symbolId: null };
}
