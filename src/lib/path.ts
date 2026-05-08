export function normalizePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return `/${parts.join("/")}`;
}

export function joinPath(basePath: string, name: string): string {
  return normalizePath(`${basePath}/${name}`);
}

export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export function getPathSegments(path: string): string[] {
  return normalizePath(path).split("/").filter(Boolean);
}

export function getBaseName(path: string): string {
  const parts = getPathSegments(path);
  return parts[parts.length - 1] || "";
}

export function isSameOrChildPath(parent: string, candidate: string): boolean {
  const normalizedParent = normalizePath(parent);
  const normalizedCandidate = normalizePath(candidate);
  return normalizedParent === normalizedCandidate || (normalizedParent !== "/" && normalizedCandidate.startsWith(`${normalizedParent}/`));
}

export function resolveRemoteTargetPath(currentPath: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return normalizePath(currentPath);
  return trimmed.startsWith("/") ? normalizePath(trimmed) : normalizePath(`${currentPath}/${trimmed}`);
}
