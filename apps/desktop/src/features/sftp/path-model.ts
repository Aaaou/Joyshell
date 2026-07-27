export function joinRemotePath(directory: string, name: string) {
  const cleanName = name.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!directory || directory === ".") {
    return cleanName;
  }
  if (directory === "/") {
    return `/${cleanName}`;
  }
  return `${directory.replace(/\/+$/, "")}/${cleanName}`;
}

export function remoteBasename(path: string) {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).pop() || path;
}

export function remoteParentDir(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    return normalized.startsWith("/") ? "/" : ".";
  }
  return normalized.slice(0, lastSlash);
}

export function buildPathCrumbs(path: string) {
  const normalized = path || "/";
  if (normalized === "." || !normalized.startsWith("/")) {
    return [{ label: normalized, path: normalized }];
  }
  const parts = normalized.split("/").filter(Boolean);
  const crumbs = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}
